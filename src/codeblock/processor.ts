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

	const records = scanEntityRecords(deps.app, deps.vaultRoot ?? DEFAULT_VAULT_ROOT);
	const filtered = queryEntities(records, parsed.args);
	renderResultsTable(el, filtered, parsed.args);
}

/**
 * Walk the vault under `vaultRoot` and build an `EntityRecord` list
 * for every markdown file with frontmatter. Exposed for testability.
 */
export function scanEntityRecords(
	app: App,
	vaultRoot: string,
): EntityRecord[] {
	const out: EntityRecord[] = [];
	const files = app.vault.getMarkdownFiles() as TFile[];
	for (const file of files) {
		if (!file.path.startsWith(vaultRoot)) continue;
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
