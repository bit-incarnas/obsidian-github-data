/**
 * Codeblock processor entry point.
 *
 * Registers a Markdown codeblock processor for each `github-*` type.
 * For every render call:
 *
 *   1. Parse + validate the YAML body (`parseCodeblockArgs`).
 *   2. If `repo:` is specified, enforce the user's allowlist (H3).
 *   3. Scan the vault for synced entity files (frontmatter pulled from
 *      `metadataCache`), filter via the pure query engine, render the
 *      result as an HTML table.
 *
 * All errors render in-place as a warning tile rather than throwing,
 * so a bad codeblock doesn't break the rest of the note.
 *
 * v0.1 scope: `source: synced` only -- the processor never issues live
 * GitHub requests. Live-fetch codeblocks arrive alongside the cron
 * slice where the rate-limit discipline can be exercised with a
 * debounce cache.
 */

import type { App, MarkdownPostProcessorContext, Plugin, TFile } from "obsidian";

import { isRepoAllowlisted } from "../settings/allowlist";
import type { GithubDataSettings } from "../settings/types";
import { queryEntities, type EntityRecord } from "./query";
import { renderError, renderResultsTable } from "./renderer";
import { parseCodeblockArgs, type CodeblockType } from "./yaml";

/**
 * Strip a leading `./` and any trailing slashes so we can apply a single
 * canonical form for prefix comparisons. `02_AREAS/GitHub/Repos` and
 * `02_AREAS/GitHub/Repos/` are equivalent vault roots.
 */
function normalizeVaultRoot(root: string): string {
	let r = root.trim();
	if (r.startsWith("./")) r = r.slice(2);
	while (r.endsWith("/")) r = r.slice(0, -1);
	return r;
}

/**
 * Directory-boundary aware ancestor check. Avoids the
 * `02_AREAS/GitHub` vs `02_AREAS/GitHub_Other` false-positive that bare
 * `String.startsWith` would produce.
 */
function isInsideRoot(filePath: string, root: string): boolean {
	if (root === "") return true;
	if (filePath === root) return true;
	return filePath.startsWith(`${root}/`);
}

const CODEBLOCK_TYPES: readonly CodeblockType[] = [
	"github-issue",
	"github-pr",
	"github-release",
	"github-dependabot",
] as const;

export const DEFAULT_VAULT_ROOT = "02_AREAS/GitHub/Repos";

/** Facts the plugin needs to answer a codeblock query. */
export interface ProcessorDeps {
	app: App;
	getSettings: () => GithubDataSettings;
	/** Vault-relative prefix to scan. Default: `02_AREAS/GitHub/Repos`. */
	vaultRoot?: string;
}

/**
 * Register codeblock processors on the plugin. Call this once from
 * `onload`.
 */
export function registerCodeblockProcessors(
	plugin: Plugin,
	deps: ProcessorDeps,
): void {
	for (const type of CODEBLOCK_TYPES) {
		plugin.registerMarkdownCodeBlockProcessor(
			type,
			(source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
				processCodeblock(source, el, type, deps);
			},
		);
	}
}

// -- pure-ish processor (exposed for tests) -----------------------------

export function processCodeblock(
	source: string,
	el: HTMLElement,
	type: CodeblockType,
	deps: ProcessorDeps,
): void {
	// Outer try/catch keeps the "render warning tile, never break the
	// note" contract even when something deep in scan/query/render
	// throws unexpectedly. Parse + allowlist failures are still handled
	// inline (cleaner messages); only unexpected throws hit this catch.
	try {
		const parsed = parseCodeblockArgs(source, type);
		if (!parsed.ok) {
			renderError(el, parsed.reason);
			return;
		}

		const settings = deps.getSettings();

		if (parsed.args.repo && !isRepoAllowlisted(settings.repoAllowlist, parsed.args.repo)) {
			renderError(
				el,
				`Repo "${parsed.args.repo}" is not in the allowlist. Add it via Settings -> GitHub Data -> Repositories.`,
			);
			return;
		}

		const records = scanEntityRecords(
			deps.app,
			deps.vaultRoot ?? DEFAULT_VAULT_ROOT,
		);
		// Even when the codeblock omits `repo:` (i.e. "all my repos"),
		// drop records whose `repo` frontmatter is not in the current
		// allowlist. Otherwise stale synced files for repos the user
		// later removed from the allowlist would still surface in
		// queries that didn't pin a specific repo.
		const allowlist = settings.repoAllowlist;
		const allowlistedRecords = records.filter((r) => {
			const repo = String(r.frontmatter.repo ?? "");
			return repo !== "" && isRepoAllowlisted(allowlist, repo);
		});
		const filtered = queryEntities(allowlistedRecords, parsed.args);
		renderResultsTable(el, filtered, parsed.args);
	} catch (err) {
		renderError(
			el,
			`Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Walk the vault under `vaultRoot` and build an `EntityRecord` list
 * for every markdown file with frontmatter. Exposed for testability.
 *
 * The directory-boundary check (`isInsideRoot`) prevents
 * `02_AREAS/GitHub` from accidentally matching files under
 * `02_AREAS/GitHub_Anything_Else/...`.
 */
export function scanEntityRecords(
	app: App,
	vaultRoot: string,
): EntityRecord[] {
	const out: EntityRecord[] = [];
	const root = normalizeVaultRoot(vaultRoot);
	const files = app.vault.getMarkdownFiles() as TFile[];
	for (const file of files) {
		if (!isInsideRoot(file.path, root)) continue;
		const cache = app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm) continue;
		out.push({
			path: file.path,
			// Obsidian tacks a `position` field onto the frontmatter cache;
			// strip it so downstream filters see only user-visible keys.
			frontmatter: stripPositionKey(
				fm as unknown as Record<string, unknown>,
			),
		});
	}
	return out;
}

function stripPositionKey(
	fm: Record<string, unknown>,
): Record<string, unknown> {
	if (!("position" in fm)) return fm;
	const { position: _position, ...rest } = fm;
	return rest;
}
