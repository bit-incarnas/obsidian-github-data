/**
 * Codeblock YAML parsing + argument validation.
 *
 * Consumes the YAML body of a `github-*` codeblock and returns a typed
 * result that downstream query / render code can consume. All four
 * codeblock types share a common validator that walks a schema per
 * type, rejecting unknown fields and type-incompatible values.
 *
 * Security invariants:
 * - Size guard (`MAX_SOURCE_BYTES`) up front to short-circuit pathological
 *   YAML before we parse. `parseYaml` itself is safe against most bombs
 *   (Obsidian's js-yaml shim has cyclic-anchor protection), but defense
 *   in depth costs nothing.
 * - Allowlist enforcement is NOT done here -- it happens in the
 *   processor, after args are validated. This module only validates the
 *   *shape* of the args.
 * - Unknown top-level fields are rejected (rather than silently ignored)
 *   so users can't paste a codeblock from the internet with surprise
 *   `author:` or `org:` qualifiers that widen the query scope beyond
 *   the author's intent.
 *
 * See 01_DESIGN.md Security Invariants -- Codeblock execution.
 */

import { parseYaml } from "obsidian";

/**
 * Hard cap on the YAML source size we'll attempt to parse. Measured in
 * UTF-16 code units (`source.length`) -- defensive approximation for
 * byte-size without pulling in `TextEncoder` (unavailable in older
 * jsdom-backed test environments).
 */
export const MAX_SOURCE_BYTES = 8 * 1024; // ~8 KB

export type CodeblockType =
	| "github-issue"
	| "github-pr"
	| "github-release"
	| "github-dependabot";

// -- args (one shape per codeblock type) ---------------------------------

export interface IssueArgs {
	type: "github-issue";
	repo?: string; // `owner/repo`; when omitted, query all allowlisted repos
	state?: "open" | "closed" | "all";
	labels?: string[];
	author?: string;
	limit?: number;
	sort?: "updated-desc" | "updated-asc" | "number-desc" | "number-asc";
	columns?: string[];
}

export interface PrArgs {
	type: "github-pr";
	repo?: string;
	state?: "open" | "closed" | "all";
	labels?: string[];
	author?: string;
	is_draft?: boolean;
	limit?: number;
	sort?: "updated-desc" | "updated-asc" | "number-desc" | "number-asc";
	columns?: string[];
}

export interface ReleaseArgs {
	type: "github-release";
	repo?: string;
	prerelease?: boolean;
	limit?: number;
	sort?: "published-desc" | "published-asc";
	columns?: string[];
}

export interface DependabotArgs {
	type: "github-dependabot";
	repo?: string;
	severity?: "critical" | "high" | "medium" | "low" | "all";
	state?: "open" | "all";
	ecosystem?: string;
	limit?: number;
	columns?: string[];
}

export type CodeblockArgs =
	| IssueArgs
	| PrArgs
	| ReleaseArgs
	| DependabotArgs;

export type ParseResult =
	| { ok: true; args: CodeblockArgs }
	| { ok: false; reason: string };

// -- field guards -------------------------------------------------------

const SHARED_FIELDS = new Set(["repo", "limit", "columns"]);

const ISSUE_FIELDS = new Set([
	...SHARED_FIELDS,
	"state",
	"labels",
	"author",
	"sort",
]);

const PR_FIELDS = new Set([
	...SHARED_FIELDS,
	"state",
	"labels",
	"author",
	"is_draft",
	"sort",
]);

const RELEASE_FIELDS = new Set([
	...SHARED_FIELDS,
	"prerelease",
	"sort",
]);

const DEPENDABOT_FIELDS = new Set([
	...SHARED_FIELDS,
	"severity",
	"state",
	"ecosystem",
]);

const REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9._-]+$/;

// -- public API ---------------------------------------------------------

/** Parse + validate a codeblock source string. */
export function parseCodeblockArgs(
	source: string,
	type: CodeblockType,
): ParseResult {
	// Size-guard first -- before we hand the string to the YAML parser.
	if (source.length > MAX_SOURCE_BYTES) {
		return {
			ok: false,
			reason: `Codeblock source exceeds ${MAX_SOURCE_BYTES} chars; refusing to parse.`,
		};
	}

	let raw: unknown;
	try {
		raw = parseYaml(source);
	} catch (err) {
		return {
			ok: false,
			reason: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// Empty body -> empty args (all fields default).
	if (raw === null || raw === undefined || raw === "") {
		raw = {};
	}

	if (typeof raw !== "object" || Array.isArray(raw)) {
		return {
			ok: false,
			reason: "Codeblock body must be a YAML object (key: value pairs).",
		};
	}

	return validateCodeblockArgs(raw as Record<string, unknown>, type);
}

/**
 * Validate a pre-parsed object against the schema for `type`. Exported
 * separately so unit tests can exercise the validator without going
 * through the YAML parser.
 */
export function validateCodeblockArgs(
	obj: Record<string, unknown>,
	type: CodeblockType,
): ParseResult {
	const allowed = allowedFieldsFor(type);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			return {
				ok: false,
				reason: `Unknown field "${key}" for ${type} (allowed: ${[...allowed].sort().join(", ")}).`,
			};
		}
	}

	// Validate each field per codeblock type. Any validation failure
	// returns the first error -- tests prefer one-at-a-time feedback
	// over concatenated error messages.
	const repo = obj.repo;
	if (repo !== undefined) {
		if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
			return {
				ok: false,
				reason: `"repo" must be a GitHub owner/repo identifier; got ${describe(repo)}.`,
			};
		}
	}

	const limit = obj.limit;
	if (limit !== undefined) {
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
			return {
				ok: false,
				reason: `"limit" must be an integer in 1..100; got ${describe(limit)}.`,
			};
		}
	}

	const columns = obj.columns;
	if (columns !== undefined) {
		if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string")) {
			return {
				ok: false,
				reason: `"columns" must be a list of strings; got ${describe(columns)}.`,
			};
		}
	}

	// Per-type validators.
	switch (type) {
		case "github-issue": {
			const err = validateIssueFields(obj);
			if (err) return { ok: false, reason: err };
			return { ok: true, args: { type, ...coerceIssue(obj) } };
		}
		case "github-pr": {
			const err = validatePrFields(obj);
			if (err) return { ok: false, reason: err };
			return { ok: true, args: { type, ...coercePr(obj) } };
		}
		case "github-release": {
			const err = validateReleaseFields(obj);
			if (err) return { ok: false, reason: err };
			return { ok: true, args: { type, ...coerceRelease(obj) } };
		}
		case "github-dependabot": {
			const err = validateDependabotFields(obj);
			if (err) return { ok: false, reason: err };
			return { ok: true, args: { type, ...coerceDependabot(obj) } };
		}
	}
}

// -- per-type validators ------------------------------------------------

function validateIssueFields(obj: Record<string, unknown>): string | null {
	if (obj.state !== undefined && !["open", "closed", "all"].includes(String(obj.state))) {
		return `"state" must be open|closed|all; got ${describe(obj.state)}.`;
	}
	if (obj.labels !== undefined && !isStringList(obj.labels)) {
		return `"labels" must be a list of strings; got ${describe(obj.labels)}.`;
	}
	if (obj.author !== undefined && typeof obj.author !== "string") {
		return `"author" must be a string; got ${describe(obj.author)}.`;
	}
	if (obj.sort !== undefined && !isIssueSort(obj.sort)) {
		return `"sort" must be updated-desc|updated-asc|number-desc|number-asc; got ${describe(obj.sort)}.`;
	}
	return null;
}

function validatePrFields(obj: Record<string, unknown>): string | null {
	// PR inherits issue fields + is_draft.
	const inherited = validateIssueFields(obj);
	if (inherited) return inherited;
	if (obj.is_draft !== undefined && typeof obj.is_draft !== "boolean") {
		return `"is_draft" must be true|false; got ${describe(obj.is_draft)}.`;
	}
	return null;
}

function validateReleaseFields(obj: Record<string, unknown>): string | null {
	if (obj.prerelease !== undefined && typeof obj.prerelease !== "boolean") {
		return `"prerelease" must be true|false; got ${describe(obj.prerelease)}.`;
	}
	if (
		obj.sort !== undefined &&
		!["published-desc", "published-asc"].includes(String(obj.sort))
	) {
		return `"sort" must be published-desc|published-asc; got ${describe(obj.sort)}.`;
	}
	return null;
}

function validateDependabotFields(
	obj: Record<string, unknown>,
): string | null {
	if (
		obj.severity !== undefined &&
		!["critical", "high", "medium", "low", "all"].includes(String(obj.severity))
	) {
		return `"severity" must be critical|high|medium|low|all; got ${describe(obj.severity)}.`;
	}
	if (obj.state !== undefined && !["open", "all"].includes(String(obj.state))) {
		return `"state" must be open|all; got ${describe(obj.state)}.`;
	}
	if (obj.ecosystem !== undefined && typeof obj.ecosystem !== "string") {
		return `"ecosystem" must be a string; got ${describe(obj.ecosystem)}.`;
	}
	return null;
}

// -- coercion (narrow strings -> enums) ---------------------------------

function coerceIssue(obj: Record<string, unknown>): Omit<IssueArgs, "type"> {
	return {
		repo: obj.repo as string | undefined,
		state: obj.state as IssueArgs["state"],
		labels: obj.labels as string[] | undefined,
		author: obj.author as string | undefined,
		limit: obj.limit as number | undefined,
		sort: obj.sort as IssueArgs["sort"],
		columns: obj.columns as string[] | undefined,
	};
}

function coercePr(obj: Record<string, unknown>): Omit<PrArgs, "type"> {
	return {
		repo: obj.repo as string | undefined,
		state: obj.state as PrArgs["state"],
		labels: obj.labels as string[] | undefined,
		author: obj.author as string | undefined,
		is_draft: obj.is_draft as boolean | undefined,
		limit: obj.limit as number | undefined,
		sort: obj.sort as PrArgs["sort"],
		columns: obj.columns as string[] | undefined,
	};
}

function coerceRelease(
	obj: Record<string, unknown>,
): Omit<ReleaseArgs, "type"> {
	return {
		repo: obj.repo as string | undefined,
		prerelease: obj.prerelease as boolean | undefined,
		limit: obj.limit as number | undefined,
		sort: obj.sort as ReleaseArgs["sort"],
		columns: obj.columns as string[] | undefined,
	};
}

function coerceDependabot(
	obj: Record<string, unknown>,
): Omit<DependabotArgs, "type"> {
	return {
		repo: obj.repo as string | undefined,
		severity: obj.severity as DependabotArgs["severity"],
		state: obj.state as DependabotArgs["state"],
		ecosystem: obj.ecosystem as string | undefined,
		limit: obj.limit as number | undefined,
		columns: obj.columns as string[] | undefined,
	};
}

// -- helpers ------------------------------------------------------------

function allowedFieldsFor(type: CodeblockType): Set<string> {
	switch (type) {
		case "github-issue":
			return ISSUE_FIELDS;
		case "github-pr":
			return PR_FIELDS;
		case "github-release":
			return RELEASE_FIELDS;
		case "github-dependabot":
			return DEPENDABOT_FIELDS;
	}
}

function isStringList(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isIssueSort(v: unknown): boolean {
	return (
		typeof v === "string" &&
		["updated-desc", "updated-asc", "number-desc", "number-asc"].includes(v)
	);
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `array(len=${value.length})`;
	if (typeof value === "object") return "object";
	return typeof value === "string" ? `"${value}"` : String(value);
}
