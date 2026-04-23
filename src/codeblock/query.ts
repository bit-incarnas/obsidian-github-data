/**
 * Codeblock query engine.
 *
 * Pure function: given a list of `EntityRecord`s (frontmatter extracted
 * from synced GitHub files) and validated `CodeblockArgs`, returns the
 * filtered / sorted / limited subset.
 *
 * The processor is responsible for supplying the input list -- typically
 * by walking `app.vault.getMarkdownFiles()` + `metadataCache.getFileCache`
 * for files under `02_AREAS/GitHub/Repos/**`. Keeping this layer pure
 * makes it trivial to unit-test without booting Obsidian.
 *
 * Allowlist enforcement is NOT done here -- the processor refuses the
 * codeblock before we're ever called. This module trusts `args.repo` to
 * have been allowlisted upstream.
 */

import type {
	CodeblockArgs,
	DependabotArgs,
	IssueArgs,
	PrArgs,
	ReleaseArgs,
} from "./yaml";

export interface EntityRecord {
	/** Vault-relative path. Used by the renderer to build file links. */
	path: string;
	frontmatter: Record<string, unknown>;
}

// -- public API ---------------------------------------------------------

export function queryEntities(
	records: EntityRecord[],
	args: CodeblockArgs,
): EntityRecord[] {
	switch (args.type) {
		case "github-issue":
			return applyIssueFilters(records, args);
		case "github-pr":
			return applyPrFilters(records, args);
		case "github-release":
			return applyReleaseFilters(records, args);
		case "github-dependabot":
			return applyDependabotFilters(records, args);
	}
}

/** The set of frontmatter `type` values for a codeblock. */
export function entityTypeFor(args: CodeblockArgs): string {
	switch (args.type) {
		case "github-issue":
			return "github_issue";
		case "github-pr":
			return "github_pr";
		case "github-release":
			return "github_release";
		case "github-dependabot":
			return "github_dependabot_alert";
	}
}

// -- per-type filter pipelines ------------------------------------------

function applyIssueFilters(
	records: EntityRecord[],
	args: IssueArgs,
): EntityRecord[] {
	let out = filterBasic(records, "github_issue", args);
	out = filterByState(out, args.state);
	out = filterByLabels(out, args.labels);
	out = filterByAuthor(out, args.author);
	out = sortIssues(out, args.sort ?? "updated-desc");
	return applyLimit(out, args.limit);
}

function applyPrFilters(
	records: EntityRecord[],
	args: PrArgs,
): EntityRecord[] {
	let out = filterBasic(records, "github_pr", args);
	out = filterByState(out, args.state);
	out = filterByLabels(out, args.labels);
	out = filterByAuthor(out, args.author);
	out = filterByIsDraft(out, args.is_draft);
	out = sortIssues(out, args.sort ?? "updated-desc");
	return applyLimit(out, args.limit);
}

function applyReleaseFilters(
	records: EntityRecord[],
	args: ReleaseArgs,
): EntityRecord[] {
	let out = filterBasic(records, "github_release", args);
	out = filterByPrerelease(out, args.prerelease);
	out = sortReleases(out, args.sort ?? "published-desc");
	return applyLimit(out, args.limit);
}

function applyDependabotFilters(
	records: EntityRecord[],
	args: DependabotArgs,
): EntityRecord[] {
	let out = filterBasic(records, "github_dependabot_alert", args);
	// default: state=open (matches UX of the existing writer).
	out = filterByState(out, args.state ?? "open");
	out = filterBySeverity(out, args.severity);
	out = filterByEcosystem(out, args.ecosystem);
	out = sortDependabot(out);
	return applyLimit(out, args.limit);
}

// -- shared filters -----------------------------------------------------

function filterBasic(
	records: EntityRecord[],
	expectedType: string,
	args: { repo?: string },
): EntityRecord[] {
	return records.filter((r) => {
		if (String(r.frontmatter.type ?? "") !== expectedType) return false;
		if (args.repo && String(r.frontmatter.repo ?? "") !== args.repo) return false;
		return true;
	});
}

function filterByState(
	records: EntityRecord[],
	state: string | undefined,
): EntityRecord[] {
	if (!state || state === "all") return records;
	return records.filter((r) => String(r.frontmatter.state ?? "") === state);
}

function filterByLabels(
	records: EntityRecord[],
	labels: string[] | undefined,
): EntityRecord[] {
	if (!labels || labels.length === 0) return records;
	return records.filter((r) => {
		const rowLabels = asStringArray(r.frontmatter.labels);
		return labels.every((requested) => rowLabels.includes(requested));
	});
}

function filterByAuthor(
	records: EntityRecord[],
	author: string | undefined,
): EntityRecord[] {
	if (!author) return records;
	return records.filter((r) => String(r.frontmatter.author ?? "") === author);
}

function filterByIsDraft(
	records: EntityRecord[],
	flag: boolean | undefined,
): EntityRecord[] {
	if (flag === undefined) return records;
	return records.filter((r) => Boolean(r.frontmatter.is_draft) === flag);
}

function filterByPrerelease(
	records: EntityRecord[],
	flag: boolean | undefined,
): EntityRecord[] {
	if (flag === undefined) return records;
	return records.filter((r) => Boolean(r.frontmatter.is_prerelease) === flag);
}

function filterBySeverity(
	records: EntityRecord[],
	severity: string | undefined,
): EntityRecord[] {
	if (!severity || severity === "all") return records;
	return records.filter((r) => String(r.frontmatter.severity ?? "") === severity);
}

function filterByEcosystem(
	records: EntityRecord[],
	ecosystem: string | undefined,
): EntityRecord[] {
	if (!ecosystem) return records;
	return records.filter((r) => String(r.frontmatter.ecosystem ?? "") === ecosystem);
}

// -- sorting ------------------------------------------------------------

function sortIssues(
	records: EntityRecord[],
	sort: IssueArgs["sort"] | PrArgs["sort"],
): EntityRecord[] {
	const sorted = [...records];
	switch (sort) {
		case "updated-desc":
			sorted.sort(
				(a, b) =>
					tsOrZero(b.frontmatter.updated) - tsOrZero(a.frontmatter.updated),
			);
			break;
		case "updated-asc":
			sorted.sort(
				(a, b) =>
					tsOrZero(a.frontmatter.updated) - tsOrZero(b.frontmatter.updated),
			);
			break;
		case "number-desc":
			sorted.sort(
				(a, b) =>
					numberOrZero(b.frontmatter.number) - numberOrZero(a.frontmatter.number),
			);
			break;
		case "number-asc":
			sorted.sort(
				(a, b) =>
					numberOrZero(a.frontmatter.number) - numberOrZero(b.frontmatter.number),
			);
			break;
	}
	return sorted;
}

function sortReleases(
	records: EntityRecord[],
	sort: ReleaseArgs["sort"],
): EntityRecord[] {
	const sorted = [...records];
	if (sort === "published-asc") {
		sorted.sort(
			(a, b) =>
				tsOrZero(a.frontmatter.published) - tsOrZero(b.frontmatter.published),
		);
	} else {
		sorted.sort(
			(a, b) =>
				tsOrZero(b.frontmatter.published) - tsOrZero(a.frontmatter.published),
		);
	}
	return sorted;
}

/**
 * Dependabot alerts sort by severity first (critical > high > medium > low),
 * then by most recently updated. The `severity` frontmatter is a string;
 * map it to a numeric rank for the comparator.
 */
function sortDependabot(records: EntityRecord[]): EntityRecord[] {
	const rank: Record<string, number> = {
		critical: 0,
		high: 1,
		medium: 2,
		low: 3,
	};
	const sorted = [...records];
	sorted.sort((a, b) => {
		const ra = rank[String(a.frontmatter.severity ?? "")] ?? 4;
		const rb = rank[String(b.frontmatter.severity ?? "")] ?? 4;
		if (ra !== rb) return ra - rb;
		return tsOrZero(b.frontmatter.updated) - tsOrZero(a.frontmatter.updated);
	});
	return sorted;
}

// -- limits + conversions ----------------------------------------------

function applyLimit(
	records: EntityRecord[],
	limit: number | undefined,
): EntityRecord[] {
	if (!limit || limit < 1) return records;
	return records.slice(0, limit);
}

function tsOrZero(v: unknown): number {
	if (typeof v !== "string") return 0;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : 0;
}

function numberOrZero(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}
