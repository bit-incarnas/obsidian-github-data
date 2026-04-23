import {
	MAX_SOURCE_BYTES,
	parseCodeblockArgs,
	validateCodeblockArgs,
	type CodeblockType,
} from "./yaml";

describe("validateCodeblockArgs -- shared field rules", () => {
	const types: CodeblockType[] = [
		"github-issue",
		"github-pr",
		"github-release",
		"github-dependabot",
	];

	test.each(types)("%s accepts an empty object (all defaults)", (type) => {
		const result = validateCodeblockArgs({}, type);
		expect(result.ok).toBe(true);
	});

	test.each(types)("%s rejects unknown top-level field", (type) => {
		const result = validateCodeblockArgs({ mystery: "x" }, type);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/Unknown field "mystery"/);
		}
	});

	test("repo must match owner/repo pattern", () => {
		const good = validateCodeblockArgs({ repo: "bit-incarnas/eden" }, "github-issue");
		expect(good.ok).toBe(true);

		const bad = validateCodeblockArgs({ repo: "not a repo" }, "github-issue");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.reason).toMatch(/owner\/repo/);
	});

	test("repo rejects non-string", () => {
		const result = validateCodeblockArgs({ repo: 42 }, "github-issue");
		expect(result.ok).toBe(false);
	});

	test("limit must be integer in 1..100", () => {
		expect(validateCodeblockArgs({ limit: 1 }, "github-issue").ok).toBe(true);
		expect(validateCodeblockArgs({ limit: 100 }, "github-issue").ok).toBe(true);
		expect(validateCodeblockArgs({ limit: 0 }, "github-issue").ok).toBe(false);
		expect(validateCodeblockArgs({ limit: 101 }, "github-issue").ok).toBe(false);
		expect(validateCodeblockArgs({ limit: 1.5 }, "github-issue").ok).toBe(false);
		expect(validateCodeblockArgs({ limit: "10" }, "github-issue").ok).toBe(false);
	});

	test("columns must be list of strings", () => {
		const good = validateCodeblockArgs(
			{ columns: ["number", "title"] },
			"github-issue",
		);
		expect(good.ok).toBe(true);

		const bad = validateCodeblockArgs(
			{ columns: ["number", 42] },
			"github-issue",
		);
		expect(bad.ok).toBe(false);
	});
});

describe("validateCodeblockArgs -- github-issue", () => {
	test("state accepts open|closed|all", () => {
		for (const state of ["open", "closed", "all"]) {
			expect(validateCodeblockArgs({ state }, "github-issue").ok).toBe(true);
		}
		expect(validateCodeblockArgs({ state: "foo" }, "github-issue").ok).toBe(false);
	});

	test("labels must be list of strings", () => {
		expect(
			validateCodeblockArgs({ labels: ["bug"] }, "github-issue").ok,
		).toBe(true);
		expect(
			validateCodeblockArgs({ labels: "bug" }, "github-issue").ok,
		).toBe(false);
	});

	test("sort accepts updated-/number- asc|desc only", () => {
		for (const sort of [
			"updated-desc",
			"updated-asc",
			"number-desc",
			"number-asc",
		]) {
			expect(validateCodeblockArgs({ sort }, "github-issue").ok).toBe(true);
		}
		expect(
			validateCodeblockArgs({ sort: "published-desc" }, "github-issue").ok,
		).toBe(false);
	});
});

describe("validateCodeblockArgs -- github-pr", () => {
	test("inherits issue fields", () => {
		expect(
			validateCodeblockArgs(
				{ state: "open", labels: ["feat"], author: "me" },
				"github-pr",
			).ok,
		).toBe(true);
	});

	test("is_draft must be boolean", () => {
		expect(
			validateCodeblockArgs({ is_draft: true }, "github-pr").ok,
		).toBe(true);
		expect(
			validateCodeblockArgs({ is_draft: "true" }, "github-pr").ok,
		).toBe(false);
	});
});

describe("validateCodeblockArgs -- github-release", () => {
	test("prerelease must be boolean", () => {
		expect(
			validateCodeblockArgs({ prerelease: true }, "github-release").ok,
		).toBe(true);
		expect(
			validateCodeblockArgs({ prerelease: "yes" }, "github-release").ok,
		).toBe(false);
	});

	test("sort accepts published-asc|desc only", () => {
		expect(
			validateCodeblockArgs({ sort: "published-desc" }, "github-release").ok,
		).toBe(true);
		expect(
			validateCodeblockArgs({ sort: "updated-desc" }, "github-release").ok,
		).toBe(false);
	});

	test("rejects issue-only fields", () => {
		// labels is not allowed on releases
		expect(
			validateCodeblockArgs({ labels: ["x"] }, "github-release").ok,
		).toBe(false);
	});
});

describe("validateCodeblockArgs -- github-dependabot", () => {
	test("severity accepts the five known levels", () => {
		for (const severity of ["critical", "high", "medium", "low", "all"]) {
			expect(
				validateCodeblockArgs({ severity }, "github-dependabot").ok,
			).toBe(true);
		}
		expect(
			validateCodeblockArgs({ severity: "unknown" }, "github-dependabot").ok,
		).toBe(false);
	});

	test("state accepts open|all only", () => {
		expect(
			validateCodeblockArgs({ state: "open" }, "github-dependabot").ok,
		).toBe(true);
		expect(
			validateCodeblockArgs({ state: "closed" }, "github-dependabot").ok,
		).toBe(false);
	});

	test("ecosystem must be string", () => {
		expect(
			validateCodeblockArgs({ ecosystem: "npm" }, "github-dependabot").ok,
		).toBe(true);
		expect(
			validateCodeblockArgs({ ecosystem: 42 }, "github-dependabot").ok,
		).toBe(false);
	});
});

describe("parseCodeblockArgs", () => {
	test("refuses oversized source", () => {
		const big = "a".repeat(MAX_SOURCE_BYTES + 1);
		const result = parseCodeblockArgs(big, "github-issue");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/exceeds/);
	});

	test("parses a simple YAML-as-JSON body", () => {
		const result = parseCodeblockArgs(
			'{"repo": "bit-incarnas/eden", "state": "open"}',
			"github-issue",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.args.type).toBe("github-issue");
			expect(result.args.repo).toBe("bit-incarnas/eden");
			if (result.args.type === "github-issue") {
				expect(result.args.state).toBe("open");
			}
		}
	});

	test("empty body produces default args", () => {
		const result = parseCodeblockArgs("", "github-pr");
		expect(result.ok).toBe(true);
	});

	test("array body rejected", () => {
		const result = parseCodeblockArgs("[1, 2, 3]", "github-issue");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/YAML object/);
	});
});
