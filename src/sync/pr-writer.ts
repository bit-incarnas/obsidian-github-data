/**
 * Pull request writer -- mirrors the issue writer with PR-specific
 * metadata (draft status, base/head branches, merged_at, requested
 * reviewers).
 *
 * Uses `client.rest.pulls.list` rather than `client.rest.issues.listForRepo`
 * + filter, for cleaner PR-shaped responses. One API call per repo
 * (paginated); no per-PR `pulls.get` call -- that would be N+1 and
 * explodes the rate-limit budget on repos with many open PRs. Fields
 * that require `pulls.get` (mergeable state, review_decision) are
 * deferred to a future enrichment pass.
 *
 * Defense layering (identical to issue writer):
 * - Allowlist + name validation (H3)
 * - joinInsideRoot path containment (C1)
 * - sanitizeGithubMarkdown over PR body (H1)
 * - processFrontMatter for YAML (C3)
 * - extract/mergePersistBlocks preserves user notes across re-sync (H2)
 */

import type { RequestError } from "@octokit/request-error";

import type { GithubClient } from "../github/client";
import {
	composeRepoFolderName,
	issueFilename,
	joinInsideRoot,
	validateRepoName,
} from "../paths/sanitize";
import { sanitizeGithubMarkdown } from "../sanitize/body";
import {
	extractPersistBlocks,
	mergePersistBlocks,
	userPersistBlock,
} from "../sanitize/persist";
import { isRepoAllowlisted } from "../settings/allowlist";
import type { VaultWriter } from "../vault/writer";

const DEFAULT_ROOT = "02_AREAS/GitHub/Repos";
const PR_SUBFOLDER = "Pull_Requests";
const SCHEMA_VERSION = 1;

export interface RepoPullRequestSyncOptions {
	client: GithubClient;
	writer: VaultWriter;
	allowlist: string[];
	vaultRoot?: string;
	now?: () => Date;
	/** Bypass user-safety body sanitation. Vault-integrity passes still run. */
	disableBodySanitation?: boolean;
}

export interface RepoPullRequestSyncResult {
	ok: boolean;
	reason?: string;
	syncedCount?: number;
	failedCount?: number;
	syncedAt?: string;
}

type PullListResponse = Awaited<
	ReturnType<GithubClient["rest"]["pulls"]["list"]>
>["data"];
type PullItem = PullListResponse[number];

export async function syncRepoPullRequests(
	owner: string,
	repo: string,
	options: RepoPullRequestSyncOptions,
): Promise<RepoPullRequestSyncResult> {
	const { client, writer, allowlist } = options;
	const vaultRoot = options.vaultRoot ?? DEFAULT_ROOT;
	const now = options.now ?? (() => new Date());
	const disableBodySanitation = options.disableBodySanitation ?? false;

	const validated = validateRepoName(owner, repo);
	if (!validated.valid) {
		return { ok: false, reason: validated.reason };
	}
	if (!isRepoAllowlisted(allowlist, `${owner}/${repo}`)) {
		return {
			ok: false,
			reason: `Repo not in allowlist: ${owner}/${repo}`,
		};
	}

	const repoFolder = composeRepoFolderName(owner, repo);
	const prFolder = joinInsideRoot(vaultRoot, repoFolder, PR_SUBFOLDER);
	if (!prFolder.ok || !prFolder.path) {
		return {
			ok: false,
			reason: prFolder.reason ?? "Path containment failed.",
		};
	}

	await writer.ensureFolder(vaultRoot);
	await writer.ensureFolder(
		joinInsideRoot(vaultRoot, repoFolder).path ?? vaultRoot,
	);
	await writer.ensureFolder(prFolder.path);

	let prs: PullItem[];
	try {
		const paginated = await client.paginate(
			client.rest.pulls.list,
			{ owner, repo, state: "open", per_page: 100 },
		);
		prs = paginated as PullItem[];
	} catch (err) {
		return { ok: false, reason: formatFetchError(err, "open PRs") };
	}

	const syncedAt = now().toISOString();
	let syncedCount = 0;
	let failedCount = 0;

	for (const pr of prs) {
		const filename = issueFilename(pr.number, pr.title ?? "");
		const fileResult = joinInsideRoot(
			vaultRoot,
			repoFolder,
			PR_SUBFOLDER,
			filename,
		);
		if (!fileResult.ok || !fileResult.path) {
			failedCount++;
			continue;
		}

		try {
			const body = await composePullRequestFile(
				pr,
				owner,
				repo,
				fileResult.path,
				writer,
				disableBodySanitation,
			);
			await writer.writeFile(fileResult.path, body);
			await writer.updateFrontmatter(fileResult.path, (fm) => {
				setPullRequestFrontmatter(fm, pr, owner, repo, syncedAt);
			});
			syncedCount++;
		} catch {
			failedCount++;
		}
	}

	return { ok: true, syncedCount, failedCount, syncedAt };
}

async function composePullRequestFile(
	pr: PullItem,
	owner: string,
	repo: string,
	filePath: string,
	writer: VaultWriter,
	disableBodySanitation: boolean,
): Promise<string> {
	const fresh = buildPullRequestBody(pr, owner, repo, disableBodySanitation);
	if (await writer.pathExists(filePath)) {
		try {
			const existing = await writer.readFile(filePath);
			const saved = extractPersistBlocks(existing);
			if (saved.length > 0) {
				return mergePersistBlocks(fresh, saved);
			}
		} catch {
			// fall through
		}
	}
	return fresh;
}

function buildPullRequestBody(
	pr: PullItem,
	owner: string,
	repo: string,
	disableBodySanitation: boolean,
): string {
	const lines: string[] = [];
	const titleSafe = pr.title ?? "(untitled)";
	lines.push(`# PR #${pr.number} -- ${titleSafe}`);
	lines.push("");

	const state = pr.state ?? "open";
	const draftMarker = pr.draft ? " (draft)" : "";
	const authorLogin = pr.user?.login ?? "unknown";
	lines.push(
		`> State: **${state}**${draftMarker} -- opened by @${authorLogin}`,
	);
	lines.push("");

	const baseRef = pr.base?.ref ?? "?";
	const headRef = pr.head?.ref ?? "?";
	lines.push(`Branch: \`${headRef}\` -> \`${baseRef}\``);
	lines.push("");

	const labels = extractLabelNames(pr);
	if (labels.length > 0) {
		lines.push(`Labels: ${labels.map((l) => `\`${l}\``).join(", ")}`);
		lines.push("");
	}

	const assignees = extractLogins(pr.assignees);
	if (assignees.length > 0) {
		lines.push(`Assignees: ${assignees.map((a) => `@${a}`).join(", ")}`);
		lines.push("");
	}

	const reviewers = extractLogins(pr.requested_reviewers);
	if (reviewers.length > 0) {
		lines.push(
			`Requested reviewers: ${reviewers.map((r) => `@${r}`).join(", ")}`,
		);
		lines.push("");
	}

	if (pr.milestone?.title) {
		lines.push(`Milestone: ${pr.milestone.title}`);
		lines.push("");
	}

	lines.push(`[View on GitHub](${pr.html_url})`);
	lines.push("");

	lines.push("## :: DESCRIPTION");
	lines.push("");
	if (pr.body && pr.body.length > 0) {
		lines.push(
			sanitizeGithubMarkdown(pr.body, {
				disableUserSafetySanitation: disableBodySanitation,
			}),
		);
	} else {
		lines.push("_(no description)_");
	}
	lines.push("");

	lines.push("## :: YOUR NOTES");
	lines.push("");
	lines.push(userPersistBlock("notes"));
	lines.push("");

	lines.push("---");
	lines.push("## :: NAV");
	lines.push(`[[${owner}/${repo}|${repo}]] -- PR #${pr.number}`);
	lines.push("");

	return lines.join("\n");
}

function setPullRequestFrontmatter(
	fm: Record<string, unknown>,
	pr: PullItem,
	owner: string,
	repo: string,
	syncedAt: string,
): void {
	fm.type = "github_pr";
	fm.repo = `${owner}/${repo}`;
	fm.number = pr.number;
	fm.state = pr.state ?? "open";
	fm.title = pr.title ?? "";
	fm.is_draft = pr.draft ?? false;
	fm.base_branch = pr.base?.ref ?? "";
	fm.head_branch = pr.head?.ref ?? "";
	fm.labels = extractLabelNames(pr);
	fm.assignees = extractLogins(pr.assignees);
	fm.requested_reviewers = extractLogins(pr.requested_reviewers);
	fm.milestone = pr.milestone?.title ?? "";
	fm.author = pr.user?.login ?? "";
	fm.created = pr.created_at ?? "";
	fm.updated = pr.updated_at ?? "";
	fm.closed = pr.closed_at ?? "";
	fm.merged_at = pr.merged_at ?? "";
	fm.html_url = pr.html_url ?? "";
	fm.last_synced = syncedAt;
	fm.schema_version = SCHEMA_VERSION;
	fm.tags = [
		"github",
		"pr",
		pr.state === "open" ? "open" : "closed",
		pr.draft ? "draft" : "ready",
	];
}

interface HasName {
	name?: string;
}
interface HasLogin {
	login?: string | null;
}

function extractLabelNames(pr: PullItem): string[] {
	const labels = pr.labels ?? [];
	return labels
		.map((l) => {
			if (typeof l === "string") return l;
			return (l as HasName).name ?? "";
		})
		.filter((n): n is string => n.length > 0);
}

function extractLogins(
	list: readonly (HasLogin | null)[] | null | undefined,
): string[] {
	if (!list) return [];
	return list
		.map((entry) => entry?.login ?? "")
		.filter((n): n is string => n.length > 0);
}

function formatFetchError(err: unknown, context: string): string {
	if (
		typeof err === "object" &&
		err !== null &&
		"status" in err &&
		"message" in err
	) {
		const e = err as RequestError;
		return `${context}: GitHub returned ${e.status} -- ${e.message}`;
	}
	if (err instanceof Error) return `${context}: ${err.message}`;
	return `${context}: unknown error`;
}
