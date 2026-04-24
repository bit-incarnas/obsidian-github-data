/**
 * Release writer -- fourth entity type.
 *
 * Fetches all releases (paginated) for each allowlisted repo and
 * writes one file per release at
 * `{vaultRoot}/{owner}__{repo}/Releases/{sanitized-tag}.md`.
 *
 * Releases are archival by nature -- they correspond to immutable
 * git tags. We always fetch the full list rather than filtering by
 * state, and keep the file for each release on disk forever.
 *
 * Same defense layering as issue / PR writers:
 * - Allowlist + name validation (H3)
 * - joinInsideRoot path containment (C1)
 * - sanitizePathSegment on tag (tag names can be arbitrary)
 * - sanitizeGithubMarkdown over release body (H1)
 * - processFrontMatter for YAML (C3)
 * - extract/mergePersistBlocks preserves user notes across re-sync (H2)
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

const DEFAULT_ROOT = "02_AREAS/GitHub/Repos";
const RELEASES_SUBFOLDER = "Releases";
const SCHEMA_VERSION = 1;

export interface RepoReleaseSyncOptions {
	client: GithubClient;
	writer: VaultWriter;
	allowlist: string[];
	vaultRoot?: string;
	now?: () => Date;
	/** Bypass user-safety body sanitation. Vault-integrity passes still run. */
	disableBodySanitation?: boolean;
}

export interface RepoReleaseSyncResult {
	ok: boolean;
	reason?: string;
	syncedCount?: number;
	failedCount?: number;
	syncedAt?: string;
}

type ReleaseListResponse = Awaited<
	ReturnType<GithubClient["rest"]["repos"]["listReleases"]>
>["data"];
type ReleaseItem = ReleaseListResponse[number];

export async function syncRepoReleases(
	owner: string,
	repo: string,
	options: RepoReleaseSyncOptions,
): Promise<RepoReleaseSyncResult> {
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
	const releasesFolder = joinInsideRoot(
		vaultRoot,
		repoFolder,
		RELEASES_SUBFOLDER,
	);
	if (!releasesFolder.ok || !releasesFolder.path) {
		return {
			ok: false,
			reason: releasesFolder.reason ?? "Path containment failed.",
		};
	}

	await writer.ensureFolder(vaultRoot);
	await writer.ensureFolder(
		joinInsideRoot(vaultRoot, repoFolder).path ?? vaultRoot,
	);
	await writer.ensureFolder(releasesFolder.path);

	let releases: ReleaseItem[];
	try {
		const paginated = await client.paginate(
			client.rest.repos.listReleases,
			{ owner, repo, per_page: 100 },
		);
		releases = paginated as ReleaseItem[];
	} catch (err) {
		return { ok: false, reason: formatFetchError(err, "releases") };
	}

	const syncedAt = now().toISOString();
	let syncedCount = 0;
	let failedCount = 0;

	for (const release of releases) {
		const tag = release.tag_name ?? "";
		if (tag.length === 0) {
			failedCount++;
			continue;
		}
		const filename = `${sanitizePathSegment(tag)}.md`;
		const fileResult = joinInsideRoot(
			vaultRoot,
			repoFolder,
			RELEASES_SUBFOLDER,
			filename,
		);
		if (!fileResult.ok || !fileResult.path) {
			failedCount++;
			continue;
		}

		try {
			const body = await composeReleaseFile(
				release,
				owner,
				repo,
				fileResult.path,
				writer,
				disableBodySanitation,
			);
			await writer.writeFile(fileResult.path, body);
			await writer.updateFrontmatter(fileResult.path, (fm) => {
				setReleaseFrontmatter(fm, release, owner, repo, syncedAt);
			});
			syncedCount++;
		} catch {
			failedCount++;
		}
	}

	return { ok: true, syncedCount, failedCount, syncedAt };
}

async function composeReleaseFile(
	release: ReleaseItem,
	owner: string,
	repo: string,
	filePath: string,
	writer: VaultWriter,
	disableBodySanitation: boolean,
): Promise<string> {
	const fresh = buildReleaseBody(release, owner, repo, disableBodySanitation);
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

function buildReleaseBody(
	release: ReleaseItem,
	owner: string,
	repo: string,
	disableBodySanitation: boolean,
): string {
	const lines: string[] = [];
	const tag = release.tag_name ?? "(no tag)";
	const name = release.name ?? tag;
	lines.push(`# ${tag} -- ${name}`);
	lines.push("");

	const stateBits: string[] = [];
	if (release.draft) stateBits.push("DRAFT");
	if (release.prerelease) stateBits.push("prerelease");
	stateBits.push(`by @${release.author?.login ?? "unknown"}`);
	lines.push(`> ${stateBits.join(" -- ")}`);
	lines.push("");

	if (release.published_at) {
		lines.push(`Published: ${release.published_at}`);
		lines.push("");
	} else if (release.created_at) {
		lines.push(`Created: ${release.created_at} (not yet published)`);
		lines.push("");
	}

	const assets = release.assets ?? [];
	if (assets.length > 0) {
		lines.push(`Assets (${assets.length}):`);
		for (const asset of assets) {
			const size = formatBytes(asset.size ?? 0);
			lines.push(
				`- [${asset.name}](${asset.browser_download_url}) -- ${size}`,
			);
		}
		lines.push("");
	}

	lines.push(`[View on GitHub](${release.html_url})`);
	lines.push("");

	lines.push("## :: NOTES");
	lines.push("");
	if (release.body && release.body.length > 0) {
		lines.push(
			sanitizeGithubMarkdown(release.body, {
				disableUserSafetySanitation: disableBodySanitation,
			}),
		);
	} else {
		lines.push("_(no release notes)_");
	}
	lines.push("");

	lines.push("## :: YOUR NOTES");
	lines.push("");
	lines.push(userPersistBlock("notes"));
	lines.push("");

	lines.push("---");
	lines.push("## :: NAV");
	lines.push(`[[${owner}/${repo}|${repo}]] -- release ${tag}`);
	lines.push("");

	return lines.join("\n");
}

function setReleaseFrontmatter(
	fm: Record<string, unknown>,
	release: ReleaseItem,
	owner: string,
	repo: string,
	syncedAt: string,
): void {
	fm.type = "github_release";
	fm.repo = `${owner}/${repo}`;
	fm.tag = release.tag_name ?? "";
	fm.name = release.name ?? "";
	fm.is_draft = release.draft ?? false;
	fm.is_prerelease = release.prerelease ?? false;
	fm.author = release.author?.login ?? "";
	fm.assets_count = (release.assets ?? []).length;
	fm.created = release.created_at ?? "";
	fm.published = release.published_at ?? "";
	fm.html_url = release.html_url ?? "";
	fm.last_synced = syncedAt;
	fm.schema_version = SCHEMA_VERSION;

	const tagList = ["github", "release"];
	if (release.draft) tagList.push("draft");
	if (release.prerelease) tagList.push("prerelease");
	fm.tags = tagList;
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
	return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
