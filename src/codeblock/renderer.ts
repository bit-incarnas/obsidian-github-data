/**
 * Codeblock renderer -- builds an HTML table from query results.
 *
 * Uses standard DOM APIs rather than Obsidian's `createEl` extensions so
 * the module is unit-testable under jsdom without mocking Obsidian
 * prototype extensions. File-link cells render as `<a class="internal-link">`
 * elements that Obsidian's click handler resolves to in-vault navigation.
 *
 * Default columns per codeblock type are chosen to match how the HUD
 * tables render, so a `github-pr` inline block looks familiar.
 */

import type { CodeblockArgs } from "./yaml";
import type { EntityRecord } from "./query";

export interface RenderOptions {
	/** Override the default columns if the codeblock specified `columns:`. */
	columns?: string[];
	/** Surfaced in empty-state message. */
	emptyMessage?: string;
}

const DEFAULT_COLUMNS: Record<CodeblockArgs["type"], string[]> = {
	"github-issue": ["file", "number", "title", "labels", "author", "updated"],
	"github-pr": [
		"file",
		"number",
		"title",
		"is_draft",
		"author",
		"updated",
	],
	"github-release": [
		"file",
		"tag",
		"name",
		"is_prerelease",
		"published",
	],
	"github-dependabot": [
		"file",
		"severity",
		"package",
		"ecosystem",
		"ghsa",
		"updated",
	],
};

const COLUMN_LABELS: Record<string, string> = {
	file: "File",
	number: "#",
	title: "Title",
	labels: "Labels",
	author: "Author",
	updated: "Updated",
	is_draft: "Draft",
	tag: "Tag",
	name: "Name",
	is_prerelease: "Prerelease",
	published: "Published",
	severity: "Severity",
	package: "Package",
	ecosystem: "Ecosystem",
	ghsa: "GHSA",
	html_url: "URL",
};

// -- public API ---------------------------------------------------------

export function renderResultsTable(
	el: HTMLElement,
	records: EntityRecord[],
	args: CodeblockArgs,
	options: RenderOptions = {},
): void {
	const columns = options.columns ?? args.columns ?? DEFAULT_COLUMNS[args.type];

	if (records.length === 0) {
		const empty = document.createElement("div");
		empty.className = "github-data-empty";
		empty.textContent =
			options.emptyMessage ?? `No ${args.type} rows match this query.`;
		el.appendChild(empty);
		return;
	}

	const table = document.createElement("table");
	table.className = "github-data-codeblock";

	const thead = document.createElement("thead");
	const headerRow = document.createElement("tr");
	for (const col of columns) {
		const th = document.createElement("th");
		th.textContent = labelFor(col);
		headerRow.appendChild(th);
	}
	thead.appendChild(headerRow);
	table.appendChild(thead);

	const tbody = document.createElement("tbody");
	for (const rec of records) {
		const row = document.createElement("tr");
		for (const col of columns) {
			const td = document.createElement("td");
			renderCell(td, col, rec);
			row.appendChild(td);
		}
		tbody.appendChild(row);
	}
	table.appendChild(tbody);

	el.appendChild(table);
}

export function renderError(el: HTMLElement, message: string): void {
	const warn = document.createElement("div");
	warn.className = "github-data-codeblock-error";
	warn.textContent = `GitHub Data codeblock: ${message}`;
	// Defensive styling fallback when the plugin's CSS isn't loaded.
	warn.style.border = "1px solid var(--color-red, #d33)";
	warn.style.padding = "0.5em 0.75em";
	warn.style.borderRadius = "4px";
	warn.style.color = "var(--color-red, #d33)";
	el.appendChild(warn);
}

// -- cell rendering ----------------------------------------------------

function renderCell(td: HTMLElement, col: string, rec: EntityRecord): void {
	if (col === "file") {
		renderFileLink(td, rec);
		return;
	}

	if (col === "html_url" || col === "url") {
		const raw = rec.frontmatter[col];
		if (typeof raw === "string" && raw.length > 0) {
			const a = document.createElement("a");
			a.textContent = raw;
			a.href = raw;
			a.setAttribute("target", "_blank");
			a.setAttribute("rel", "noopener noreferrer");
			td.appendChild(a);
		}
		return;
	}

	const value = rec.frontmatter[col];
	td.textContent = stringify(value);
}

function renderFileLink(td: HTMLElement, rec: EntityRecord): void {
	// Use Obsidian's internal-link convention. Click handler inside
	// Obsidian resolves `data-href` to the target note, so the rendered
	// anchor behaves like a wiki-link at runtime.
	const basename = rec.path.split("/").pop()?.replace(/\.md$/, "") ?? rec.path;
	const a = document.createElement("a");
	a.className = "internal-link";
	a.textContent = basename;
	a.setAttribute("data-href", rec.path);
	a.setAttribute("href", rec.path);
	a.setAttribute("target", "_blank");
	a.setAttribute("rel", "noopener");
	td.appendChild(a);
}

function labelFor(col: string): string {
	return COLUMN_LABELS[col] ?? col;
}

function stringify(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
	if (typeof v === "boolean") return v ? "yes" : "no";
	return String(v);
}
