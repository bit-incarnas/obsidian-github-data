/**
 * First real sync path: repo profile.
 *
 * For each allowlisted repo, fetches `GET /repos/{owner}/{repo}`, tries
 * to fetch the README (tolerating 404), and writes a markdown file at
 * `{vaultRoot}/{owner}__{repo}/00_{repo}.md` with structured frontmatter
 * and a readable body.
 *
 * Defensive layering:
 * - Allowlist enforcement (Security Invariant H3): fails closed if the
 *   repo isn't in the allowlist, even if explicitly passed.
 * - Path containment (Security Invariant C1): every path composed via
 *   `joinInsideRoot` so malformed `owner`/`repo` can't escape the root.
 * - README fencing (L3 from the security review): README body wrapped
 *   in a fenced code block for v0.1 -- defeats inline-HTML / Templater /
 *   Dataview execution from synced content while the full middle-ground
 *   sanitizer is still being built.
 * - Frontmatter via `processFrontMatter`: strings never concatenated
 *   into YAML; Obsidian's serializer escapes safely (Security Invariant
 *   C3).
 *
 * Not yet handled (deferred slices):
 * - Persist blocks (issues/PRs, not repo profile)
 * - Update modes (none/update/append) -- repo profile always overwrites
 * - Full body sanitizer for H1 (READMEs currently fenced-as-code)
 * - ETag conditional requests -- sync is idempotent but not bandwidth-
 *   minimal yet
 */

import type { RequestError } from "@octokit/request-error";

import type { GithubClient } from "../github/client";
import {
	composeRepoFolderName,
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

export interface RepoProfileSyncOptions {
	client: GithubClient;
	writer: VaultWriter;
	allowlist: string[];
	/** Vault-relative root where repo folders are created. */
	vaultRoot?: string;
	/** Clock injection for deterministic tests. */
	now?: () => Date;
	/** Bypass user-safety body sanitation. Vault-integrity passes still run. */
	disableBodySanitation?: boolean;
}

export interface SyncResult {
	ok: boolean;
	path?: string;
	reason?: string;
	syncedAt?: string;
}

const DEFAULT_ROOT = "02_AREAS/GitHub/Repos";
const SCHEMA_VERSION = 1;

type Repo = Awaited<
	ReturnType<GithubClient["rest"]["repos"]["get"]>
>["data"];

export async function syncRepoProfile(
	owner: string,
	repo: string,
	options: RepoProfileSyncOptions,
): Promise<SyncResult> {
	const { client, writer, allowlist } = options;
	const vaultRoot = options.vaultRoot ?? DEFAULT_ROOT;
	const now = options.now ?? (() => new Date());
	const disableBodySanitation = options.disableBodySanitation ?? false;

	// Validate + enforce allowlist up front.
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

	// Compose the target path. Containment check rejects escapes.
	const repoFolder = composeRepoFolderName(owner, repo);
	const folderResult = joinInsideRoot(vaultRoot, repoFolder);
	if (!folderResult.ok || !folderResult.path) {
		return {
			ok: false,
			reason: folderResult.reason ?? "Path containment failed.",
		};
	}
	const folderPath = folderResult.path;

	const fileResult = joinInsideRoot(
		vaultRoot,
		repoFolder,
		`00_${sanitizePathSegment(repo)}.md`,
	);
	if (!fileResult.ok || !fileResult.path) {
		return {
			ok: false,
			reason: fileResult.reason ?? "Path containment failed.",
		};
	}
	const filePath = fileResult.path;

	// Fetch metadata.
	let repoData: Repo;
	try {
		const res = await client.rest.repos.get({ owner, repo });
		repoData = res.data;
	} catch (err) {
		return { ok: false, reason: formatFetchError(err, "repo metadata") };
	}

	// Try to fetch README (optional; 404 is fine).
	let readmeMarkdown: string | null = null;
	try {
		const res = await client.rest.repos.getReadme({
			owner,
			repo,
			mediaType: { format: "raw" },
		});
		// Raw media returns `data` as the raw string body.
		readmeMarkdown = typeof res.data === "string" ? res.data : null;
	} catch (err) {
		if (!isNotFound(err)) {
			return { ok: false, reason: formatFetchError(err, "README") };
		}
	}

	const syncedAt = now().toISOString();
	const freshBody = buildRepoProfileBody(
		repoData,
		readmeMarkdown,
		disableBodySanitation,
	);

	// Ensure the target folder exists before any read/write.
	await writer.ensureFolder(vaultRoot);
	await writer.ensureFolder(folderPath);

	// Preserve user-authored persist blocks across re-sync. On first
	// write there is no existing file, so nothing to preserve.
	let bodyToWrite = freshBody;
	if (await writer.pathExists(filePath)) {
		try {
			const existing = await writer.readFile(filePath);
			const savedBlocks = extractPersistBlocks(existing);
			if (savedBlocks.length > 0) {
				bodyToWrite = mergePersistBlocks(freshBody, savedBlocks);
			}
		} catch {
			// Read failed for some reason -- proceed with fresh body rather
			// than blocking the sync. Orphan preservation is best-effort.
		}
	}

	await writer.writeFile(filePath, bodyToWrite);
	await writer.updateFrontmatter(filePath, (fm) => {
		setRepoProfileFrontmatter(fm, repoData, syncedAt);
	});

	return { ok: true, path: filePath, syncedAt };
}

function setRepoProfileFrontmatter(
	fm: Record<string, unknown>,
	repo: Repo,
	syncedAt: string,
): void {
	fm.type = "github_repo";
	fm.repo = repo.full_name;
	fm.owner = repo.owner.login;
	fm.name = repo.name;
	fm.description = repo.description ?? "";
	fm.language = repo.language ?? "";
	fm.topics = Array.isArray(repo.topics) ? repo.topics : [];
	fm.visibility = repo.visibility ?? (repo.private ? "private" : "public");
	fm.stars = repo.stargazers_count ?? 0;
	fm.forks = repo.forks_count ?? 0;
	fm.open_issues_plus_prs = repo.open_issues_count ?? 0;
	fm.default_branch = repo.default_branch ?? "";
	fm.license = repo.license?.spdx_id ?? "";
	fm.homepage = repo.homepage ?? "";
	fm.html_url = repo.html_url ?? "";
	fm.created = repo.created_at ?? "";
	fm.pushed = repo.pushed_at ?? "";
	fm.last_synced = syncedAt;
	fm.schema_version = SCHEMA_VERSION;
	fm.tags = ["github", "repo"];
}

function buildRepoProfileBody(
	repo: Repo,
	readmeMarkdown: string | null,
	disableBodySanitation: boolean,
): string {
	const lines: string[] = [];
	lines.push(`# ${repo.full_name}`);
	lines.push("");
	if (repo.description) {
		lines.push(`> ${repo.description}`);
		lines.push("");
	}

	lines.push("## :: STATS");
	lines.push("");
	lines.push("| Attribute | Value |");
	lines.push("| :-------- | :---- |");
	lines.push(`| Language | ${repo.language ?? "(none)"} |`);
	lines.push(
		`| Visibility | ${repo.visibility ?? (repo.private ? "private" : "public")} |`,
	);
	lines.push(`| Default branch | ${repo.default_branch ?? "(unknown)"} |`);
	lines.push(`| Stars | ${repo.stargazers_count ?? 0} |`);
	lines.push(`| Forks | ${repo.forks_count ?? 0} |`);
	lines.push(
		`| Open issues + PRs | ${repo.open_issues_count ?? 0} |`,
	);
	lines.push(`| License | ${repo.license?.spdx_id ?? "(none)"} |`);
	lines.push(`| Homepage | ${repo.homepage ?? "(none)"} |`);
	lines.push(`| URL | ${repo.html_url ?? ""} |`);
	lines.push("");

	if (readmeMarkdown && readmeMarkdown.length > 0) {
		lines.push("## :: README");
		lines.push("");
		lines.push(
			sanitizeGithubMarkdown(readmeMarkdown, {
				disableUserSafetySanitation: disableBodySanitation,
			}),
		);
		lines.push("");
	}

	// User-notes region preserved across re-sync. The content between
	// the persist markers is whatever the user writes; template default
	// is empty.
	lines.push("## :: YOUR NOTES");
	lines.push("");
	lines.push(userPersistBlock("notes"));
	lines.push("");

	lines.push("---");
	lines.push("## :: NAV");
	lines.push(`[[${repo.full_name}|${repo.full_name} on GitHub]]`);
	lines.push("");

	return lines.join("\n");
}

function isNotFound(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"status" in err &&
		(err as RequestError).status === 404
	);
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
	if (err instanceof Error) {
		return `${context}: ${err.message}`;
	}
	return `${context}: unknown error`;
}
