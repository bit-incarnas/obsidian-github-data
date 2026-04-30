/**
 * Charter hydration.
 *
 * Reads the synced repo tree (`02_AREAS/GitHub/Repos/{o}__{r}/...`) and
 * pushes a fixed set of `gh_*` frontmatter keys into any vault file that
 * has opted in via `github_repo: owner/repo` in its frontmatter.
 *
 * **Opt-in only.** A charter (or any vault file) becomes hydrate-able by
 * adding `github_repo: bit-incarnas/eden` (or any allowlisted repo) to
 * its frontmatter. Files without the marker are never touched. The plugin
 * does not iterate `03_PROJECTS/` or any project folder; it iterates the
 * vault's full markdown set and filters by the marker. Lets users put
 * the marker on whatever file they want hydrated -- charter, HUD, daily
 * note -- without configuration surface.
 *
 * **Read-only data flow.** No new GitHub calls are made. Hydration is a
 * pure vault-to-vault transformation over already-synced data: profile
 * frontmatter, entity counts derived from path-prefix matching, and the
 * most recent release's tag + published date. Nothing else in the
 * charter file is read or modified -- body content is preserved
 * verbatim, non-`gh_*` frontmatter keys are preserved verbatim.
 *
 * **Idempotency.** Each hydration run computes the desired `gh_*` block
 * and compares it (excluding `gh_hydrated_at`) against the existing
 * frontmatter. Files whose computed values are unchanged are not written
 * -- this avoids touching the `mtime` and triggering Obsidian Sync /
 * iCloud / git-pre-commit churn on no-op runs. `gh_hydrated_at` only
 * advances when other fields actually change, so the timestamp tracks
 * "when the data last changed," not "when the button was last pressed."
 *
 * The fields:
 *
 * | Charter field | Source |
 * | :------------ | :----- |
 * | `gh_repo` | Echoed from `github_repo` (canonicalized) |
 * | `gh_open_issues` | Count of files under `.../{o}__{r}/Issues/` |
 * | `gh_open_prs` | Count under `.../Pull_Requests/` |
 * | `gh_open_dependabot_alerts` | Count under `.../Dependabot/` |
 * | `gh_last_release` | Tag of release with the latest `published_at`, or null |
 * | `gh_default_branch` | From the repo profile frontmatter |
 * | `gh_last_synced` | From the repo profile frontmatter |
 * | `gh_hydrated_at` | ISO timestamp; only refreshed when other gh_* values change |
 */

import { canonicalizeRepoEntry, isRepoAllowlisted } from "../settings/allowlist";

/**
 * Root under which every repo writer deposits entity folders. Matches
 * `DEFAULT_ROOT` in the five sync writers + `REPOS_ROOT` in
 * `sync-progress-data`. Redefined here rather than imported so the
 * sync layer doesn't take a dependency on the UI layer.
 */
export const REPOS_ROOT = "02_AREAS/GitHub/Repos";

const ENTITY_SUBFOLDERS = {
	issues: "Issues",
	prs: "Pull_Requests",
	releases: "Releases",
	dependabot: "Dependabot",
} as const;

const HYDRATION_KEYS = [
	"gh_repo",
	"gh_open_issues",
	"gh_open_prs",
	"gh_open_dependabot_alerts",
	"gh_last_release",
	"gh_default_branch",
	"gh_last_synced",
] as const;

type HydrationKey = (typeof HYDRATION_KEYS)[number];

/**
 * One vault file with its parsed frontmatter (or `null` if absent).
 * The caller (main.ts) gathers this from `app.metadataCache.getFileCache`.
 */
export interface VaultFileSnapshot {
	path: string;
	frontmatter: Record<string, unknown> | null;
}

export interface RepoHydrationData {
	repoKey: string;
	profile: Record<string, unknown> | null;
	counts: {
		issues: number;
		prs: number;
		dependabot: number;
	};
	latestRelease: {
		tag: string;
		publishedAt: string | null;
	} | null;
}

export type HydrationPlanStatus = "ok" | "skipped";

export interface HydrationPlan {
	/** Vault path of the charter / file with the `github_repo` marker. */
	path: string;
	/** Canonical owner/repo from the marker. */
	repoKey: string;
	/** What we'd write to this file (only set when `status === "ok"`). */
	updates?: Record<string, unknown>;
	/**
	 * "ok" when the file should be written; "skipped" when not (reason in
	 * `reason`). Idempotent skip ("no change") is a separate case from
	 * skip-because-error -- callers can distinguish via `reason`.
	 */
	status: HydrationPlanStatus;
	reason?: string;
}

export interface BuildHydrationPlansOptions {
	/** All vault markdown files with their frontmatter. */
	vaultFiles: VaultFileSnapshot[];
	/** Current repo allowlist. */
	allowlist: string[];
	/** Now-ISO injected for deterministic tests. */
	nowIso: string;
}

/**
 * Pure entry point. Returns one plan per opt-in file (charter or
 * otherwise). Files without a `github_repo` marker are not in the result.
 */
export function buildHydrationPlans(
	options: BuildHydrationPlansOptions,
): HydrationPlan[] {
	const { vaultFiles, allowlist, nowIso } = options;
	const plans: HydrationPlan[] = [];

	// First pass: index synced files by repo so we don't re-scan the full
	// vault file list for every charter.
	const repoIndex = indexSyncedFilesByRepo(vaultFiles);

	for (const file of vaultFiles) {
		const marker = readGithubRepoMarker(file.frontmatter);
		if (marker == null) continue; // not opted in

		if (marker === "") {
			plans.push({
				path: file.path,
				repoKey: "",
				status: "skipped",
				reason: "github_repo marker is empty or non-string",
			});
			continue;
		}

		// Shape-validate before allowlist check so a malformed marker
		// (e.g., "no-slash-here", "trailing/", "/leading", "a/b/c") gets
		// a useful "invalid marker" reason instead of being mis-reported
		// as "not in the allowlist."
		if (!isValidRepoMarker(marker)) {
			plans.push({
				path: file.path,
				repoKey: marker,
				status: "skipped",
				reason: `invalid github_repo marker "${marker}" -- expected exactly one slash separating owner and repo, e.g. "owner/repo"`,
			});
			continue;
		}

		if (!isRepoAllowlisted(allowlist, marker)) {
			plans.push({
				path: file.path,
				repoKey: marker,
				status: "skipped",
				reason: `repo ${marker} is not in the allowlist`,
			});
			continue;
		}

		const repoKey = canonicalizeRepoEntry(marker);
		const data = repoIndex.get(repoKey);
		if (!data || data.profile == null) {
			plans.push({
				path: file.path,
				repoKey,
				status: "skipped",
				reason: `no synced repo profile for ${repoKey} -- run "Sync all repo profiles" first`,
			});
			continue;
		}

		const desired = buildHydrationFrontmatter(data, nowIso);

		// Idempotency: only emit an "ok" plan if any non-timestamp value
		// would actually change. `gh_hydrated_at` is excluded from the
		// diff, then carried over from the existing frontmatter when
		// nothing else changed (so the timestamp keeps tracking "last
		// real change," not "last command invocation").
		if (frontmatterMatches(file.frontmatter, desired)) {
			plans.push({
				path: file.path,
				repoKey,
				status: "skipped",
				reason: "no change since last hydration",
			});
			continue;
		}

		plans.push({
			path: file.path,
			repoKey,
			status: "ok",
			updates: { ...desired, gh_hydrated_at: nowIso },
		});
	}

	return plans;
}

/**
 * Apply a hydration plan to a frontmatter object, mutating it in place.
 * Designed for use inside `processFrontMatter`'s mutate callback.
 *
 * Only `gh_*` keys are written; everything else is preserved.
 */
export function applyHydrationUpdates(
	fm: Record<string, unknown>,
	updates: Record<string, unknown>,
): void {
	for (const [k, v] of Object.entries(updates)) {
		fm[k] = v;
	}
}

// ---- internals ---------------------------------------------------------

function readGithubRepoMarker(
	fm: Record<string, unknown> | null,
): string | null {
	if (!fm) return null;
	if (!Object.prototype.hasOwnProperty.call(fm, "github_repo")) return null;
	const raw = fm.github_repo;
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim();
	return trimmed.length === 0 ? "" : trimmed;
}

/**
 * Surface-level shape check for the `github_repo` marker. Intentionally
 * lenient -- the writers' own `parseRepoPath` runs the rigorous
 * containment / homoglyph / Windows-reserved checks. This guard's only
 * job is to stop "not in the allowlist" being a misleading reason for
 * markers that obviously aren't a repo path. Allowlist canonicalization
 * still runs after this passes.
 */
function isValidRepoMarker(marker: string): boolean {
	const parts = marker.split("/");
	if (parts.length !== 2) return false;
	const [owner, repo] = parts;
	if (!owner || !repo) return false;
	return true;
}

interface IndexedRepo {
	repoKey: string;
	profile: Record<string, unknown> | null;
	counts: {
		issues: number;
		prs: number;
		dependabot: number;
	};
	releases: Array<{ tag: string; publishedAt: string | null }>;
}

function indexSyncedFilesByRepo(
	files: readonly VaultFileSnapshot[],
): Map<string, RepoHydrationData> {
	const reposPrefix = `${REPOS_ROOT}/`.toLowerCase();
	const intermediate = new Map<string, IndexedRepo>();

	for (const file of files) {
		const lower = file.path.toLowerCase();
		if (!lower.startsWith(reposPrefix)) continue;
		const rel = lower.slice(reposPrefix.length);
		const slashIdx = rel.indexOf("/");
		if (slashIdx <= 0) continue;
		const repoFolder = rel.slice(0, slashIdx); // owner__repo
		const remainder = rel.slice(slashIdx + 1);
		const parts = repoFolder.split("__");
		if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
		const repoKey = `${parts[0]}/${parts[1]}`;

		let entry = intermediate.get(repoKey);
		if (!entry) {
			entry = {
				repoKey,
				profile: null,
				counts: { issues: 0, prs: 0, dependabot: 0 },
				releases: [],
			};
			intermediate.set(repoKey, entry);
		}

		// Profile file at the repo root (e.g., "00_<repo>.md").
		if (!remainder.includes("/")) {
			// Heuristic: only treat as profile if the file has a
			// `github_repo`-style frontmatter shape (`type: github_repo`).
			const fm = file.frontmatter ?? null;
			if (fm && fm.type === "github_repo") {
				entry.profile = fm;
			}
			continue;
		}

		// Entity file inside a subfolder.
		if (remainder.startsWith(ENTITY_SUBFOLDERS.issues.toLowerCase() + "/")) {
			entry.counts.issues++;
			continue;
		}
		if (remainder.startsWith(ENTITY_SUBFOLDERS.prs.toLowerCase() + "/")) {
			entry.counts.prs++;
			continue;
		}
		if (remainder.startsWith(ENTITY_SUBFOLDERS.dependabot.toLowerCase() + "/")) {
			entry.counts.dependabot++;
			continue;
		}
		if (remainder.startsWith(ENTITY_SUBFOLDERS.releases.toLowerCase() + "/")) {
			const fm = file.frontmatter ?? {};
			const tag = pickString(fm.tag) ?? deriveTagFromPath(file.path);
			// release-writer writes the published timestamp to `published`,
			// not `published_at`. Reading the wrong key here meant
			// publishedAt was always null and the latest-release pick fell
			// back to lexicographic tag order rather than recency.
			const publishedAt = pickString(fm.published);
			if (tag) {
				entry.releases.push({ tag, publishedAt });
			}
		}
	}

	const out = new Map<string, RepoHydrationData>();
	for (const [repoKey, entry] of intermediate) {
		out.set(repoKey, {
			repoKey,
			profile: entry.profile,
			counts: entry.counts,
			latestRelease: pickLatestRelease(entry.releases),
		});
	}
	return out;
}

function pickLatestRelease(
	releases: Array<{ tag: string; publishedAt: string | null }>,
): { tag: string; publishedAt: string | null } | null {
	if (releases.length === 0) return null;
	let best = releases[0];
	for (const r of releases.slice(1)) {
		if (compareReleases(r, best) > 0) best = r;
	}
	return best;
}

/**
 * Compare two releases. The release with the more recent `publishedAt`
 * wins. A null `publishedAt` loses to any string. Tie-breaker is tag
 * lexicographic order so the result is deterministic.
 */
function compareReleases(
	a: { tag: string; publishedAt: string | null },
	b: { tag: string; publishedAt: string | null },
): number {
	if (a.publishedAt && !b.publishedAt) return 1;
	if (!a.publishedAt && b.publishedAt) return -1;
	if (a.publishedAt && b.publishedAt) {
		if (a.publishedAt > b.publishedAt) return 1;
		if (a.publishedAt < b.publishedAt) return -1;
	}
	return a.tag.localeCompare(b.tag);
}

function deriveTagFromPath(path: string): string | null {
	const parts = path.split("/");
	const filename = parts[parts.length - 1];
	if (!filename || !filename.toLowerCase().endsWith(".md")) return null;
	return filename.slice(0, -3);
}

function buildHydrationFrontmatter(
	data: RepoHydrationData,
	nowIso: string,
): Record<string, unknown> {
	const profile = data.profile ?? {};
	return {
		gh_repo: data.repoKey,
		gh_open_issues: data.counts.issues,
		gh_open_prs: data.counts.prs,
		gh_open_dependabot_alerts: data.counts.dependabot,
		gh_last_release: data.latestRelease?.tag ?? null,
		gh_default_branch: pickString(profile.default_branch),
		gh_last_synced: pickString(profile.last_synced),
		gh_hydrated_at: nowIso, // overwritten on output if no real change
	};
}

/**
 * Compare existing frontmatter against the desired hydration block,
 * IGNORING `gh_hydrated_at`. Returns true if every hydration key already
 * matches (so a write would be a no-op).
 */
function frontmatterMatches(
	existing: Record<string, unknown> | null,
	desired: Record<string, unknown>,
): boolean {
	if (!existing) return false;
	for (const key of HYDRATION_KEYS) {
		const a = (existing as Record<string, unknown>)[key];
		const b = desired[key];
		if (!equivalent(a, b)) return false;
	}
	return true;
}

/**
 * Loose equivalence: handles null/undefined symmetry (a charter that
 * has never been hydrated has `undefined`; we'd write `null` for
 * "no value"; treat as equal so we don't churn on first-time hits
 * where the source data is genuinely empty).
 */
function equivalent(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if ((a === null || a === undefined) && (b === null || b === undefined)) {
		return true;
	}
	return false;
}

function pickString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export const HYDRATOR_INTERNALS_FOR_TESTS = {
	HYDRATION_KEYS,
	indexSyncedFilesByRepo,
	pickLatestRelease,
	compareReleases,
};

export type { HydrationKey };
