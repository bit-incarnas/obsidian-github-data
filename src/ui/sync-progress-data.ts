/**
 * Pure data layer for the Sync Progress view.
 *
 * Takes the plugin settings plus the vault's flat list of markdown files
 * and returns one status row per allowlisted repo. Zero Obsidian
 * imports -- the module is 100% unit-testable and has no I/O. The view
 * layer is responsible for asking Obsidian for the file list and
 * rendering the rows.
 */

import type {
	GithubDataSettings,
	SyncErrorRecord,
} from "../settings/types";

export interface RepoStatusRow {
	/** Original `owner/repo` string as stored in the allowlist. */
	repo: string;
	/** Lowercased + trimmed repo path used for path prefix matching. */
	repoKey: string;
	/** ISO-8601 timestamp of last successful sync; null if never synced. */
	lastSyncedAt: string | null;
	counts: {
		issues: number;
		prs: number;
		releases: number;
		dependabot: number;
	};
	lastError: SyncErrorRecord | null;
}

export interface ProgressFileRef {
	path: string;
}

/**
 * Root under which every writer deposits repo entity folders. Matches
 * `DEFAULT_ROOT` in each of the five sync writers (`02_AREAS/GitHub/Repos`).
 * If a future slice makes the root configurable, wire it through here.
 */
export const REPOS_ROOT = "02_AREAS/GitHub/Repos";

/** Folder name per entity class -- relative to the per-repo folder. */
const ENTITY_SUBFOLDERS = {
	issues: "Issues",
	prs: "Pull_Requests",
	releases: "Releases",
	dependabot: "Dependabot",
} as const;

/**
 * Compose one `RepoStatusRow` per entry in `settings.repoAllowlist`.
 * Entries that look malformed (missing `/`, empty halves) are silently
 * skipped so the view doesn't render rows that can't map to a folder.
 */
export function buildRepoStatusRows(
	settings: GithubDataSettings,
	markdownFiles: Iterable<ProgressFileRef>,
): RepoStatusRow[] {
	const files = Array.from(markdownFiles);
	const rows: RepoStatusRow[] = [];
	for (const entry of settings.repoAllowlist) {
		const trimmed = entry.trim();
		// Require exactly two non-empty path segments. Drops "invalid",
		// "owner/", "/repo", and `owner/repo/extra` -- the last form
		// previously slipped past an indexOf check and rendered a
		// misleading truncated row.
		const parts = trimmed.split("/");
		if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
		const owner = parts[0].toLowerCase();
		const repo = parts[1].toLowerCase();
		const repoKey = `${owner}/${repo}`;
		const counts = countEntitiesForRepo(owner, repo, files);
		rows.push({
			repo: trimmed,
			repoKey,
			// Read by canonical key so a non-canonical allowlist entry
			// (e.g., hand-edited `data.json`) still resolves against
			// writes made by the sync loops.
			lastSyncedAt: pickString(settings.lastSyncedAt[repoKey]),
			counts,
			lastError: settings.lastSyncError[repoKey] ?? null,
		});
	}
	return rows;
}

function countEntitiesForRepo(
	owner: string,
	repo: string,
	files: ProgressFileRef[],
): RepoStatusRow["counts"] {
	const folderPrefix = `${REPOS_ROOT}/${owner}__${repo}/`.toLowerCase();
	const counts = { issues: 0, prs: 0, releases: 0, dependabot: 0 };
	for (const f of files) {
		const lower = f.path.toLowerCase();
		if (!lower.startsWith(folderPrefix)) continue;
		// Remaining path segment after the repo folder.
		const rel = lower.slice(folderPrefix.length);
		if (rel.startsWith(ENTITY_SUBFOLDERS.issues.toLowerCase() + "/")) {
			counts.issues++;
			continue;
		}
		if (rel.startsWith(ENTITY_SUBFOLDERS.prs.toLowerCase() + "/")) {
			counts.prs++;
			continue;
		}
		if (rel.startsWith(ENTITY_SUBFOLDERS.releases.toLowerCase() + "/")) {
			counts.releases++;
			continue;
		}
		if (rel.startsWith(ENTITY_SUBFOLDERS.dependabot.toLowerCase() + "/")) {
			counts.dependabot++;
			continue;
		}
		// Profile file at the repo root (e.g., `00_repo.md`) -- intentionally
		// not counted as an entity.
	}
	return counts;
}

function pickString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Render a Date-compatible ISO string as a short "N {unit} ago" label.
 * Pure so the test file can exercise it deterministically; the view
 * injects `now` for stable output.
 */
export function formatRelativeTime(
	iso: string | null,
	now: Date = new Date(),
): string {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "never";
	const deltaMs = now.getTime() - then;
	if (deltaMs < 0) return "just now";
	const s = Math.floor(deltaMs / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}d ago`;
	const mo = Math.floor(d / 30);
	if (mo < 12) return `${mo}mo ago`;
	const y = Math.floor(d / 365);
	return `${y}y ago`;
}
