/**
 * Issue writer -- second entity type in the sync engine.
 *
 * For each allowlisted repo, fetches open issues (PRs filtered out)
 * and writes one file per issue at
 * `{vaultRoot}/{owner}__{repo}/Issues/{number}-{slug}.md`.
 *
 * Follows the same defense layering as the repo profile writer:
 * - Allowlist check before any API call (Security Invariant H3)
 * - `joinInsideRoot` path containment (C1)
 * - `processFrontMatter` for atomic YAML (C3)
 * - Body sanitizer over issue body + comments (H1)
 * - Persist-block preservation across re-sync (H2)
 *
 * Scope for v0.1:
 * - Open issues only (closed-issue archival is a separate slice)
 * - No comments fetch yet (one API call per issue is enough for v0.1)
 * - No labels-as-tags conversion yet (labels in frontmatter)
 * - No closed-since-last-sync cleanup yet
 */

import type { RequestError } from "@octokit/request-error";

import type { GithubClient } from "../github/client";
import {
	composeRepoFolderName,
	issueFilename,
	joinInsideRoot,
	sanitizePathSegment,
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
const ISSUES_SUBFOLDER = "Issues";
const SCHEMA_VERSION = 1;

export interface RepoIssueSyncOptions {
	client: GithubClient;
	writer: VaultWriter;
	allowlist: string[];
	vaultRoot?: string;
	now?: () => Date;
}

export interface RepoIssueSyncResult {
	ok: boolean;
	reason?: string;
	syncedCount?: number;
	failedCount?: number;
	syncedAt?: string;
}

type IssueListResponse = Awaited<
	ReturnType<GithubClient["rest"]["issues"]["listForRepo"]>
>["data"];
type IssueItem = IssueListResponse[number];

export async function syncRepoIssues(
	owner: string,
	repo: string,
	options: RepoIssueSyncOptions,
): Promise<RepoIssueSyncResult> {
	const { client, writer, allowlist } = options;
	const vaultRoot = options.vaultRoot ?? DEFAULT_ROOT;
	const now = options.now ?? (() => new Date());

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
	const issuesFolder = joinInsideRoot(
		vaultRoot,
		repoFolder,
		ISSUES_SUBFOLDER,
	);
	if (!issuesFolder.ok || !issuesFolder.path) {
		return {
			ok: false,
			reason: issuesFolder.reason ?? "Path containment failed.",
		};
	}

	await writer.ensureFolder(vaultRoot);
	await writer.ensureFolder(
		joinInsideRoot(vaultRoot, repoFolder).path ?? vaultRoot,
	);
	await writer.ensureFolder(issuesFolder.path);

	// Fetch ALL pages of open issues. The paginate helper handles the
	// Link header walk.
	let issues: IssueItem[];
	try {
		const paginated = await client.paginate(
			client.rest.issues.listForRepo,
			{ owner, repo, state: "open", per_page: 100 },
		);
		// `/issues` returns PRs mixed in; PRs carry `pull_request` field.
		issues = (paginated as IssueItem[]).filter(
			(i) => !(i as unknown as { pull_request?: unknown }).pull_request,
		);
	} catch (err) {
		return {
			ok: false,
			reason: formatFetchError(err, "open issues"),
		};
	}

	const syncedAt = now().toISOString();
	let syncedCount = 0;
	let failedCount = 0;

	for (const issue of issues) {
		const filename = issueFilename(issue.number, issue.title ?? "");
		const fileResult = joinInsideRoot(
			vaultRoot,
			repoFolder,
			ISSUES_SUBFOLDER,
			filename,
		);
		if (!fileResult.ok || !fileResult.path) {
			failedCount++;
			continue;
		}

		try {
			const body = await composeIssueFile(
				issue,
				owner,
				repo,
				fileResult.path,
				writer,
			);
			await writer.writeFile(fileResult.path, body);
			await writer.updateFrontmatter(fileResult.path, (fm) => {
				setIssueFrontmatter(fm, issue, owner, repo, syncedAt);
			});
			syncedCount++;
		} catch {
			failedCount++;
		}
	}

	return { ok: true, syncedCount, failedCount, syncedAt };
}

async function composeIssueFile(
	issue: IssueItem,
	owner: string,
	repo: string,
	filePath: string,
	writer: VaultWriter,
): Promise<string> {
	const fresh = buildIssueBody(issue, owner, repo);

	// Preserve user persist blocks on re-sync.
	if (await writer.pathExists(filePath)) {
		try {
			const existing = await writer.readFile(filePath);
			const saved = extractPersistBlocks(existing);
			if (saved.length > 0) {
				return mergePersistBlocks(fresh, saved);
			}
		} catch {
			// fall through to fresh body
		}
	}
	return fresh;
}

function buildIssueBody(
	issue: IssueItem,
	owner: string,
	repo: string,
): string {
	const lines: string[] = [];
	const titleSafe = issue.title ?? "(untitled)";
	lines.push(`# #${issue.number} -- ${titleSafe}`);
	lines.push("");

	const state = issue.state ?? "open";
	const authorLogin = issue.user?.login ?? "unknown";
	lines.push(`> State: **${state}** -- opened by @${authorLogin}`);
	lines.push("");

	const labels = extractLabelNames(issue);
	if (labels.length > 0) {
		lines.push(`Labels: ${labels.map((l) => `\`${l}\``).join(", ")}`);
		lines.push("");
	}

	const assignees = extractAssignees(issue);
	if (assignees.length > 0) {
		lines.push(`Assignees: ${assignees.map((a) => `@${a}`).join(", ")}`);
		lines.push("");
	}

	if (issue.milestone?.title) {
		lines.push(`Milestone: ${issue.milestone.title}`);
		lines.push("");
	}

	lines.push(`[View on GitHub](${issue.html_url})`);
	lines.push("");

	lines.push("## :: BODY");
	lines.push("");
	if (issue.body && issue.body.length > 0) {
		lines.push(sanitizeGithubMarkdown(issue.body));
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
	lines.push(`[[${owner}/${repo}|${repo}]] -- issue #${issue.number}`);
	lines.push("");

	return lines.join("\n");
}

function setIssueFrontmatter(
	fm: Record<string, unknown>,
	issue: IssueItem,
	owner: string,
	repo: string,
	syncedAt: string,
): void {
	fm.type = "github_issue";
	fm.repo = `${owner}/${repo}`;
	fm.number = issue.number;
	fm.state = issue.state ?? "open";
	fm.title = issue.title ?? "";
	fm.labels = extractLabelNames(issue);
	fm.assignees = extractAssignees(issue);
	fm.milestone = issue.milestone?.title ?? "";
	fm.author = issue.user?.login ?? "";
	fm.comments_count = issue.comments ?? 0;
	fm.created = issue.created_at ?? "";
	fm.updated = issue.updated_at ?? "";
	fm.closed = issue.closed_at ?? "";
	fm.html_url = issue.html_url ?? "";
	fm.last_synced = syncedAt;
	fm.schema_version = SCHEMA_VERSION;
	fm.tags = ["github", "issue", issue.state === "open" ? "open" : "closed"];
}

function extractLabelNames(issue: IssueItem): string[] {
	const labels = issue.labels ?? [];
	return labels
		.map((l) => {
			if (typeof l === "string") return l;
			return (l as { name?: string }).name ?? "";
		})
		.filter((n): n is string => n.length > 0);
}

function extractAssignees(issue: IssueItem): string[] {
	const list = issue.assignees ?? [];
	return list
		.map((a) => a?.login ?? "")
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
