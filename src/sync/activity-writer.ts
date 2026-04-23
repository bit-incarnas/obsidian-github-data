/**
 * Activity aggregator.
 *
 * Fetches a user's contributionsCollection for a sliding window and
 * writes one markdown file per day into
 * `02_AREAS/GitHub/Activity/YYYY-MM/YYYY-MM-DD.md`, with per-day rollup
 * frontmatter + a per-repo breakdown table in the body.
 *
 * This slice delivers resolution #3 (commit counts feed the Telemetry
 * Grid as a measured builder-output axis alongside focus / energy /
 * sleep). The files are pure data -- downstream consumption (Telemetry
 * Grid Dataview query, Heatmap Calendar integration) lands in follow-up
 * mini-slices once the data exists on disk.
 *
 * Frontmatter schema is defined in 01_DESIGN.md Data Schema:
 *   type: github_activity_day
 *   date: YYYY-MM-DD
 *   commits_total: number
 *   prs_opened: number
 *   prs_merged: number
 *   issues_opened: number
 *   issues_closed: number
 *   reviews_given: number
 *   releases: number (always 0 in this slice; follow-up will cross-ref
 *     the Releases/ folder or add a REST fan-out)
 *   last_synced: ISO-8601 UTC
 *   schema_version: 1
 *   tags: ["github", "activity"]
 *
 * Aggregation rules:
 * - `commits_total` is summed across all repos on that day.
 * - `prs_opened` / `issues_opened` / `reviews_given` count nodes whose
 *   `occurredAt` falls on that day.
 * - `prs_merged` is derived from `pullRequest.mergedAt` (when the user
 *   authored a PR that eventually merged, it's counted on the merge
 *   date, not the open date).
 * - `issues_closed` is derived from `issue.closedAt` similarly.
 * - Per-repo breakdown in the body captures commits / PRs-opened /
 *   issues-opened / reviews per repo.
 *
 * Allowlist interaction: activity is user-centric (across all repos the
 * authenticated user contributed to). We do NOT filter by allowlist --
 * the point is to capture the full contribution picture. If a user
 * prefers to exclude certain repos, use a fine-grained PAT that can't
 * see them.
 */

import type { GithubClient } from "../github/client";
import {
	fetchContributionsCollection,
	fetchViewerLogin,
	type ContributionsCollection,
} from "../github/graphql";
import { joinInsideRoot } from "../paths/sanitize";
import {
	extractPersistBlocks,
	mergePersistBlocks,
	userPersistBlock,
} from "../sanitize/persist";
import type { VaultWriter } from "../vault/writer";

// -- public types --------------------------------------------------------

export interface SyncActivityOptions {
	client: GithubClient;
	writer: VaultWriter;
	/** How many days back from `now` to sync. Default 30. */
	windowDays?: number;
	/** Authenticated user's login. If omitted, fetched via GraphQL. */
	login?: string;
	/** Vault-relative root for activity files. */
	vaultRoot?: string;
	/** Clock injection for deterministic tests. */
	now?: () => Date;
}

export interface SyncActivityResult {
	ok: boolean;
	totalDays?: number;
	writtenCount?: number;
	failedCount?: number;
	from?: string;
	to?: string;
	login?: string;
	reason?: string;
}

export interface ActivityDay {
	date: string; // YYYY-MM-DD
	commits_total: number;
	prs_opened: number;
	prs_merged: number;
	issues_opened: number;
	issues_closed: number;
	reviews_given: number;
	releases: number;
	per_repo: Map<string, RepoContribution>;
}

export interface RepoContribution {
	commits: number;
	prs_opened: number;
	issues_opened: number;
	reviews: number;
}

// -- public API ----------------------------------------------------------

const DEFAULT_ROOT = "02_AREAS/GitHub/Activity";
const SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_DAYS = 30;

export async function syncActivity(
	options: SyncActivityOptions,
): Promise<SyncActivityResult> {
	const { client, writer } = options;
	const vaultRoot = options.vaultRoot ?? DEFAULT_ROOT;
	const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
	const nowFn = options.now ?? (() => new Date());
	const now = nowFn();

	// Resolve viewer login if not supplied.
	let login = options.login;
	if (!login) {
		try {
			login = await fetchViewerLogin(client);
		} catch (err) {
			return { ok: false, reason: formatFetchError(err, "viewer login") };
		}
	}

	// Window: [now - windowDays, now] -- inclusive of today.
	const from = new Date(now.getTime() - windowDays * 86_400_000);
	const fromIso = from.toISOString();
	const toIso = now.toISOString();

	let data: ContributionsCollection;
	try {
		data = await fetchContributionsCollection(client, login, fromIso, toIso);
	} catch (err) {
		return {
			ok: false,
			reason: formatFetchError(err, "contributionsCollection"),
			login,
			from: fromIso,
			to: toIso,
		};
	}

	const days = aggregateActivityByDay(data);
	const totalDays = days.size;

	await writer.ensureFolder(vaultRoot);

	let writtenCount = 0;
	let failedCount = 0;
	for (const day of days.values()) {
		try {
			await writeActivityDay(writer, day, vaultRoot, now);
			writtenCount += 1;
		} catch (err) {
			console.warn(
				`[github-data] activity write failed for ${day.date}:`,
				err,
			);
			failedCount += 1;
		}
	}

	return {
		ok: true,
		totalDays,
		writtenCount,
		failedCount,
		from: fromIso,
		to: toIso,
		login,
	};
}

// -- aggregator ----------------------------------------------------------

/**
 * Collapse a `contributionsCollection` into per-day rollups. Pure
 * function -- deterministic for the same input, easily testable.
 */
export function aggregateActivityByDay(
	data: ContributionsCollection,
): Map<string, ActivityDay> {
	const days = new Map<string, ActivityDay>();

	const getDay = (dateKey: string): ActivityDay => {
		let d = days.get(dateKey);
		if (!d) {
			d = {
				date: dateKey,
				commits_total: 0,
				prs_opened: 0,
				prs_merged: 0,
				issues_opened: 0,
				issues_closed: 0,
				reviews_given: 0,
				releases: 0,
				per_repo: new Map(),
			};
			days.set(dateKey, d);
		}
		return d;
	};

	const getRepo = (day: ActivityDay, name: string): RepoContribution => {
		let r = day.per_repo.get(name);
		if (!r) {
			r = { commits: 0, prs_opened: 0, issues_opened: 0, reviews: 0 };
			day.per_repo.set(name, r);
		}
		return r;
	};

	// Commits per repo per day.
	for (const entry of data.commitContributionsByRepository) {
		const name = entry.repository.nameWithOwner;
		for (const node of entry.contributions.nodes) {
			const dateKey = toDateKey(node.occurredAt);
			const day = getDay(dateKey);
			day.commits_total += node.commitCount;
			getRepo(day, name).commits += node.commitCount;
		}
	}

	// PRs opened -- plus `prs_merged` on the actual merge date.
	for (const node of data.pullRequestContributions.nodes) {
		const openedKey = toDateKey(node.occurredAt);
		const openedDay = getDay(openedKey);
		openedDay.prs_opened += 1;
		getRepo(openedDay, node.pullRequest.repository.nameWithOwner).prs_opened +=
			1;

		if (node.pullRequest.merged && node.pullRequest.mergedAt) {
			const mergedKey = toDateKey(node.pullRequest.mergedAt);
			getDay(mergedKey).prs_merged += 1;
		}
	}

	// Issues opened -- plus `issues_closed` on the close date.
	for (const node of data.issueContributions.nodes) {
		const openedKey = toDateKey(node.occurredAt);
		const openedDay = getDay(openedKey);
		openedDay.issues_opened += 1;
		getRepo(openedDay, node.issue.repository.nameWithOwner).issues_opened +=
			1;

		if (node.issue.closedAt) {
			const closedKey = toDateKey(node.issue.closedAt);
			getDay(closedKey).issues_closed += 1;
		}
	}

	// Reviews given.
	for (const node of data.pullRequestReviewContributions.nodes) {
		const dateKey = toDateKey(node.occurredAt);
		const day = getDay(dateKey);
		day.reviews_given += 1;
		getRepo(day, node.pullRequest.repository.nameWithOwner).reviews += 1;
	}

	return days;
}

// -- writer helpers ------------------------------------------------------

async function writeActivityDay(
	writer: VaultWriter,
	day: ActivityDay,
	vaultRoot: string,
	now: Date,
): Promise<void> {
	const yearMonth = day.date.slice(0, 7); // YYYY-MM

	const folderResult = joinInsideRoot(vaultRoot, yearMonth);
	if (!folderResult.ok || !folderResult.path) {
		throw new Error(
			folderResult.reason ?? `Path containment failed for ${day.date}`,
		);
	}
	const folderPath = folderResult.path;

	const fileResult = joinInsideRoot(vaultRoot, yearMonth, `${day.date}.md`);
	if (!fileResult.ok || !fileResult.path) {
		throw new Error(
			fileResult.reason ?? `Path containment failed for ${day.date}`,
		);
	}
	const filePath = fileResult.path;

	await writer.ensureFolder(folderPath);

	const freshBody = buildActivityBody(day);

	let bodyToWrite = freshBody;
	if (await writer.pathExists(filePath)) {
		try {
			const existing = await writer.readFile(filePath);
			const savedBlocks = extractPersistBlocks(existing);
			if (savedBlocks.length > 0) {
				bodyToWrite = mergePersistBlocks(freshBody, savedBlocks);
			}
		} catch {
			// Best-effort persist preservation; proceed with fresh body.
		}
	}

	await writer.writeFile(filePath, bodyToWrite);
	await writer.updateFrontmatter(filePath, (fm) => {
		setActivityFrontmatter(fm, day, now.toISOString());
	});
}

function setActivityFrontmatter(
	fm: Record<string, unknown>,
	day: ActivityDay,
	syncedAt: string,
): void {
	fm.type = "github_activity_day";
	fm.date = day.date;
	fm.commits_total = day.commits_total;
	fm.prs_opened = day.prs_opened;
	fm.prs_merged = day.prs_merged;
	fm.issues_opened = day.issues_opened;
	fm.issues_closed = day.issues_closed;
	fm.reviews_given = day.reviews_given;
	fm.releases = day.releases;
	fm.last_synced = syncedAt;
	fm.schema_version = SCHEMA_VERSION;
	fm.tags = ["github", "activity"];
}

export function buildActivityBody(day: ActivityDay): string {
	const lines: string[] = [];
	lines.push(`# Activity -- ${day.date}`);
	lines.push("");
	lines.push("## :: SUMMARY");
	lines.push("");
	lines.push("| Metric | Count |");
	lines.push("| :----- | :---- |");
	lines.push(`| Commits | ${day.commits_total} |`);
	lines.push(`| PRs opened | ${day.prs_opened} |`);
	lines.push(`| PRs merged | ${day.prs_merged} |`);
	lines.push(`| Issues opened | ${day.issues_opened} |`);
	lines.push(`| Issues closed | ${day.issues_closed} |`);
	lines.push(`| Reviews given | ${day.reviews_given} |`);
	lines.push("");

	if (day.per_repo.size > 0) {
		lines.push("## :: PER-REPO BREAKDOWN");
		lines.push("");
		lines.push("| Repo | Commits | PRs opened | Issues opened | Reviews |");
		lines.push("| :--- | :-----: | :--------: | :-----------: | :-----: |");

		// Sort repos by commits desc, then name.
		const entries = [...day.per_repo.entries()].sort((a, b) => {
			const delta = b[1].commits - a[1].commits;
			return delta !== 0 ? delta : a[0].localeCompare(b[0]);
		});
		for (const [name, r] of entries) {
			lines.push(
				`| ${name} | ${r.commits} | ${r.prs_opened} | ${r.issues_opened} | ${r.reviews} |`,
			);
		}
		lines.push("");
	}

	lines.push("## :: YOUR NOTES");
	lines.push("");
	lines.push(userPersistBlock("notes"));
	lines.push("");

	lines.push("---");
	lines.push("## :: NAV");
	lines.push(
		`[[${day.date}]] | [[02_AREAS/GitHub/Activity/${day.date.slice(0, 7)}/${day.date}|Activity]]`,
	);
	lines.push("");

	return lines.join("\n");
}

// -- utilities -----------------------------------------------------------

/**
 * Convert an ISO-8601 datetime to a YYYY-MM-DD key using UTC. Using UTC
 * keeps bucket boundaries consistent regardless of the machine's local
 * timezone -- important because `occurredAt` from GitHub is UTC.
 */
function toDateKey(iso: string): string {
	return iso.slice(0, 10);
}

function formatFetchError(err: unknown, context: string): string {
	if (err instanceof Error) {
		return `${context}: ${err.message}`;
	}
	return `${context}: ${String(err)}`;
}
