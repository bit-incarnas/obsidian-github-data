/**
 * Dependabot alerts writer -- fifth entity type.
 *
 * Fetches open Dependabot alerts per allowlisted repo and writes one
 * file per alert at
 * `{vaultRoot}/{owner}__{repo}/Dependabot/{number}-{package}-{severity}.md`.
 *
 * Scope for v0.1:
 * - Open alerts only (dismissed/fixed archived separately; not in this
 *   slice -- see retention policy in 01_DESIGN.md)
 * - All severities in same folder; severity appears in filename + tags
 *   so Dataview can filter by severity-bucketed views
 * - Requires `Dependabot alerts: read` PAT scope. 403 with a clear
 *   scope-related message is surfaced as a structured error.
 * - 404 (Dependabot alerts disabled on a public / personal-tier repo)
 *   is tolerated as an empty list so the command doesn'\''t error out
 *   across an allowlist that contains both enabled + disabled repos.
 *
 * Defense layering identical to other writers.
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
const DEPENDABOT_SUBFOLDER = "Dependabot";
const SCHEMA_VERSION = 1;

export interface RepoDependabotSyncOptions {
	client: GithubClient;
	writer: VaultWriter;
	allowlist: string[];
	vaultRoot?: string;
	now?: () => Date;
	/** Bypass user-safety body sanitation. Vault-integrity passes still run. */
	disableBodySanitation?: boolean;
}

export interface RepoDependabotSyncResult {
	ok: boolean;
	reason?: string;
	syncedCount?: number;
	failedCount?: number;
	skipped?: "alerts-disabled";
	syncedAt?: string;
}

type AlertListResponse = Awaited<
	ReturnType<GithubClient["rest"]["dependabot"]["listAlertsForRepo"]>
>["data"];
type AlertItem = AlertListResponse[number];

export async function syncRepoDependabotAlerts(
	owner: string,
	repo: string,
	options: RepoDependabotSyncOptions,
): Promise<RepoDependabotSyncResult> {
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
	const alertsFolder = joinInsideRoot(
		vaultRoot,
		repoFolder,
		DEPENDABOT_SUBFOLDER,
	);
	if (!alertsFolder.ok || !alertsFolder.path) {
		return {
			ok: false,
			reason: alertsFolder.reason ?? "Path containment failed.",
		};
	}

	await writer.ensureFolder(vaultRoot);
	await writer.ensureFolder(
		joinInsideRoot(vaultRoot, repoFolder).path ?? vaultRoot,
	);

	let alerts: AlertItem[];
	try {
		const paginated = await client.paginate(
			client.rest.dependabot.listAlertsForRepo,
			{ owner, repo, state: "open", per_page: 100 },
		);
		alerts = paginated as AlertItem[];
	} catch (err) {
		// 404 = Dependabot alerts disabled on this repo. Not a failure.
		if (isNotFound(err)) {
			return { ok: true, skipped: "alerts-disabled", syncedCount: 0 };
		}
		return {
			ok: false,
			reason: formatFetchError(err, "Dependabot alerts"),
		};
	}

	// Only ensure the folder if there's at least one alert. Keeps the
	// tree clean on repos with no vulnerabilities.
	if (alerts.length === 0) {
		return {
			ok: true,
			syncedCount: 0,
			syncedAt: now().toISOString(),
		};
	}

	await writer.ensureFolder(alertsFolder.path);

	const syncedAt = now().toISOString();
	let syncedCount = 0;
	let failedCount = 0;

	for (const alert of alerts) {
		const filename = alertFilename(alert);
		const fileResult = joinInsideRoot(
			vaultRoot,
			repoFolder,
			DEPENDABOT_SUBFOLDER,
			filename,
		);
		if (!fileResult.ok || !fileResult.path) {
			failedCount++;
			continue;
		}

		try {
			const body = await composeAlertFile(
				alert,
				owner,
				repo,
				fileResult.path,
				writer,
				disableBodySanitation,
			);
			await writer.writeFile(fileResult.path, body);
			await writer.updateFrontmatter(fileResult.path, (fm) => {
				setAlertFrontmatter(fm, alert, owner, repo, syncedAt);
			});
			syncedCount++;
		} catch {
			failedCount++;
		}
	}

	return { ok: true, syncedCount, failedCount, syncedAt };
}

function alertFilename(alert: AlertItem): string {
	const number = alert.number;
	const pkg = alert.dependency?.package?.name ?? "unknown";
	const severity =
		alert.security_advisory?.severity ??
		alert.security_vulnerability?.severity ??
		"unknown";
	return `${number}-${sanitizePathSegment(pkg)}-${sanitizePathSegment(severity)}.md`;
}

async function composeAlertFile(
	alert: AlertItem,
	owner: string,
	repo: string,
	filePath: string,
	writer: VaultWriter,
	disableBodySanitation: boolean,
): Promise<string> {
	const fresh = buildAlertBody(alert, owner, repo, disableBodySanitation);
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

function buildAlertBody(
	alert: AlertItem,
	owner: string,
	repo: string,
	disableBodySanitation: boolean,
): string {
	const lines: string[] = [];
	const pkg = alert.dependency?.package?.name ?? "unknown";
	const ecosystem = alert.dependency?.package?.ecosystem ?? "unknown";
	const severity = alert.security_advisory?.severity ?? "unknown";
	const ghsaId = alert.security_advisory?.ghsa_id ?? "";
	const summary = alert.security_advisory?.summary ?? "(no summary)";

	lines.push(`# Dependabot #${alert.number} -- ${pkg} (${severity})`);
	lines.push("");
	lines.push(`> ${summary}`);
	lines.push("");

	lines.push("## :: DETAILS");
	lines.push("");
	lines.push("| Attribute | Value |");
	lines.push("| :-------- | :---- |");
	lines.push(`| Package | \`${pkg}\` |`);
	lines.push(`| Ecosystem | \`${ecosystem}\` |`);
	lines.push(`| Severity | **${severity}** |`);
	lines.push(`| State | ${alert.state ?? "open"} |`);
	lines.push(`| GHSA | ${ghsaId || "(n/a)"} |`);
	const cveId = findCveId(alert);
	lines.push(`| CVE | ${cveId || "(n/a)"} |`);
	const vulnRange = alert.security_vulnerability?.vulnerable_version_range ?? "";
	lines.push(`| Vulnerable range | \`${vulnRange || "(unknown)"}\` |`);
	const fixedIn = alert.security_vulnerability?.first_patched_version?.identifier ?? "";
	lines.push(`| Fixed in | ${fixedIn || "(no fix yet)"} |`);
	const manifest = alert.dependency?.manifest_path ?? "";
	lines.push(`| Manifest | \`${manifest || "(unknown)"}\` |`);
	lines.push("");

	if (alert.html_url) {
		lines.push(`[View alert on GitHub](${alert.html_url})`);
		lines.push("");
	}

	const description = alert.security_advisory?.description ?? "";
	if (description.length > 0) {
		lines.push("## :: ADVISORY DESCRIPTION");
		lines.push("");
		lines.push(
			sanitizeGithubMarkdown(description, {
				disableUserSafetySanitation: disableBodySanitation,
			}),
		);
		lines.push("");
	}

	const references = alert.security_advisory?.references ?? [];
	if (references.length > 0) {
		lines.push("## :: REFERENCES");
		lines.push("");
		for (const ref of references) {
			if (ref.url) lines.push(`- ${ref.url}`);
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
		`[[${owner}/${repo}|${repo}]] -- Dependabot #${alert.number}`,
	);
	lines.push("");

	return lines.join("\n");
}

function setAlertFrontmatter(
	fm: Record<string, unknown>,
	alert: AlertItem,
	owner: string,
	repo: string,
	syncedAt: string,
): void {
	const pkg = alert.dependency?.package?.name ?? "";
	const ecosystem = alert.dependency?.package?.ecosystem ?? "";
	const severity = alert.security_advisory?.severity ?? "unknown";
	fm.type = "github_dependabot_alert";
	fm.repo = `${owner}/${repo}`;
	fm.number = alert.number;
	fm.state = alert.state ?? "open";
	fm.package = pkg;
	fm.ecosystem = ecosystem;
	fm.severity = severity;
	fm.ghsa = alert.security_advisory?.ghsa_id ?? "";
	fm.cve = findCveId(alert);
	fm.summary = alert.security_advisory?.summary ?? "";
	fm.vulnerable_range =
		alert.security_vulnerability?.vulnerable_version_range ?? "";
	fm.fixed_in =
		alert.security_vulnerability?.first_patched_version?.identifier ?? "";
	fm.manifest_path = alert.dependency?.manifest_path ?? "";
	fm.created = alert.created_at ?? "";
	fm.updated = alert.updated_at ?? "";
	fm.dismissed_at = alert.dismissed_at ?? "";
	fm.fixed_at = alert.fixed_at ?? "";
	fm.html_url = alert.html_url ?? "";
	fm.last_synced = syncedAt;
	fm.schema_version = SCHEMA_VERSION;
	fm.tags = [
		"github",
		"dependabot",
		"security",
		`severity/${severity}`,
	];
}

function findCveId(alert: AlertItem): string {
	const direct = alert.security_advisory?.cve_id;
	if (direct) return direct;
	const identifiers = alert.security_advisory?.identifiers ?? [];
	const cve = identifiers.find((i) => i.type === "CVE");
	return cve?.value ?? "";
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
		if (e.status === 403) {
			return `${context}: 403 (PAT may lack \`Dependabot alerts: read\` scope) -- ${e.message}`;
		}
		return `${context}: GitHub returned ${e.status} -- ${e.message}`;
	}
	if (err instanceof Error) return `${context}: ${err.message}`;
	return `${context}: unknown error`;
}
