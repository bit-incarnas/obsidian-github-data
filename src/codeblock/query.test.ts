import { queryEntities, entityTypeFor, type EntityRecord } from "./query";
import type { CodeblockArgs } from "./yaml";

function rec(
	path: string,
	frontmatter: Record<string, unknown>,
): EntityRecord {
	return { path, frontmatter };
}

describe("entityTypeFor", () => {
	test("maps codeblock types to frontmatter types", () => {
		expect(
			entityTypeFor({ type: "github-issue" } as CodeblockArgs),
		).toBe("github_issue");
		expect(entityTypeFor({ type: "github-pr" } as CodeblockArgs)).toBe(
			"github_pr",
		);
		expect(
			entityTypeFor({ type: "github-release" } as CodeblockArgs),
		).toBe("github_release");
		expect(
			entityTypeFor({ type: "github-dependabot" } as CodeblockArgs),
		).toBe("github_dependabot_alert");
	});
});

describe("queryEntities -- github-issue", () => {
	const base: EntityRecord[] = [
		rec("a", {
			type: "github_issue",
			repo: "x/y",
			state: "open",
			number: 1,
			updated: "2026-04-20T10:00:00Z",
			labels: ["bug"],
			author: "me",
		}),
		rec("b", {
			type: "github_issue",
			repo: "x/y",
			state: "closed",
			number: 2,
			updated: "2026-04-21T10:00:00Z",
			labels: ["enhancement"],
			author: "other",
		}),
		rec("c", {
			type: "github_issue",
			repo: "p/q",
			state: "open",
			number: 3,
			updated: "2026-04-22T10:00:00Z",
			labels: ["bug", "security"],
			author: "me",
		}),
		rec("d", {
			type: "github_pr",
			repo: "x/y",
			state: "open",
			number: 4,
			updated: "2026-04-22T11:00:00Z",
		}),
	];

	test("filters to github_issue frontmatter type", () => {
		const out = queryEntities(base, { type: "github-issue" });
		expect(out.map((r) => r.path)).not.toContain("d");
	});

	test("filters by repo", () => {
		const out = queryEntities(base, {
			type: "github-issue",
			repo: "x/y",
		});
		expect(out.map((r) => r.path).sort()).toEqual(["a", "b"]);
	});

	test("default state is all (no filter)", () => {
		const out = queryEntities(base, {
			type: "github-issue",
		});
		expect(out.map((r) => r.path).sort()).toEqual(["a", "b", "c"]);
	});

	test("state=open filters to open", () => {
		const out = queryEntities(base, {
			type: "github-issue",
			state: "open",
		});
		expect(out.map((r) => r.path).sort()).toEqual(["a", "c"]);
	});

	test("labels filter is AND (all labels must match)", () => {
		const out = queryEntities(base, {
			type: "github-issue",
			labels: ["bug", "security"],
		});
		expect(out.map((r) => r.path)).toEqual(["c"]);
	});

	test("labels filter is case-insensitive", () => {
		// Mixed-case both sides -- the user typed `Bug` in their codeblock,
		// the issue frontmatter stores `bug` (or vice versa).
		const mixedCase = [
			rec("a", {
				type: "github_issue",
				repo: "x/y",
				state: "open",
				labels: ["Bug", "SECURITY"],
			}),
		];
		const out = queryEntities(mixedCase, {
			type: "github-issue",
			labels: ["bug", "security"],
		});
		expect(out.map((r) => r.path)).toEqual(["a"]);

		const out2 = queryEntities(mixedCase, {
			type: "github-issue",
			labels: ["BUG"],
		});
		expect(out2.map((r) => r.path)).toEqual(["a"]);
	});

	test("author filter", () => {
		const out = queryEntities(base, {
			type: "github-issue",
			author: "me",
		});
		expect(out.map((r) => r.path).sort()).toEqual(["a", "c"]);
	});

	test("updated-desc sorts latest first", () => {
		const out = queryEntities(base, {
			type: "github-issue",
			sort: "updated-desc",
		});
		expect(out.map((r) => r.path)).toEqual(["c", "b", "a"]);
	});

	test("number-asc sorts by number ascending", () => {
		const out = queryEntities(base, {
			type: "github-issue",
			sort: "number-asc",
		});
		expect(out.map((r) => r.path)).toEqual(["a", "b", "c"]);
	});

	test("limit trims the result", () => {
		const out = queryEntities(base, {
			type: "github-issue",
			limit: 2,
		});
		expect(out).toHaveLength(2);
	});
});

describe("queryEntities -- github-pr", () => {
	const records: EntityRecord[] = [
		rec("a", {
			type: "github_pr",
			repo: "x/y",
			state: "open",
			number: 1,
			is_draft: true,
			updated: "2026-04-20T10:00:00Z",
		}),
		rec("b", {
			type: "github_pr",
			repo: "x/y",
			state: "open",
			number: 2,
			is_draft: false,
			updated: "2026-04-22T10:00:00Z",
		}),
	];

	test("is_draft filter (true)", () => {
		const out = queryEntities(records, {
			type: "github-pr",
			is_draft: true,
		});
		expect(out.map((r) => r.path)).toEqual(["a"]);
	});

	test("is_draft filter (false)", () => {
		const out = queryEntities(records, {
			type: "github-pr",
			is_draft: false,
		});
		expect(out.map((r) => r.path)).toEqual(["b"]);
	});

	test("default sort is updated-desc", () => {
		const out = queryEntities(records, { type: "github-pr" });
		expect(out.map((r) => r.path)).toEqual(["b", "a"]);
	});
});

describe("queryEntities -- github-release", () => {
	const records: EntityRecord[] = [
		rec("a", {
			type: "github_release",
			repo: "x/y",
			tag: "v1",
			is_prerelease: false,
			published: "2026-04-01T10:00:00Z",
		}),
		rec("b", {
			type: "github_release",
			repo: "x/y",
			tag: "v2",
			is_prerelease: true,
			published: "2026-04-05T10:00:00Z",
		}),
		rec("c", {
			type: "github_release",
			repo: "x/y",
			tag: "v3",
			is_prerelease: false,
			published: "2026-04-10T10:00:00Z",
		}),
	];

	test("default sort is published-desc", () => {
		const out = queryEntities(records, { type: "github-release" });
		expect(out.map((r) => r.path)).toEqual(["c", "b", "a"]);
	});

	test("prerelease=true filters to prereleases", () => {
		const out = queryEntities(records, {
			type: "github-release",
			prerelease: true,
		});
		expect(out.map((r) => r.path)).toEqual(["b"]);
	});

	test("prerelease=false excludes prereleases", () => {
		const out = queryEntities(records, {
			type: "github-release",
			prerelease: false,
		});
		expect(out.map((r) => r.path).sort()).toEqual(["a", "c"]);
	});

	test("published-asc flips the order", () => {
		const out = queryEntities(records, {
			type: "github-release",
			sort: "published-asc",
		});
		expect(out.map((r) => r.path)).toEqual(["a", "b", "c"]);
	});
});

describe("queryEntities -- github-dependabot", () => {
	const records: EntityRecord[] = [
		rec("low1", {
			type: "github_dependabot_alert",
			repo: "x/y",
			severity: "low",
			state: "open",
			ecosystem: "npm",
			updated: "2026-04-20T10:00:00Z",
		}),
		rec("crit1", {
			type: "github_dependabot_alert",
			repo: "x/y",
			severity: "critical",
			state: "open",
			ecosystem: "pip",
			updated: "2026-04-18T10:00:00Z",
		}),
		rec("high1", {
			type: "github_dependabot_alert",
			repo: "x/y",
			severity: "high",
			state: "open",
			ecosystem: "npm",
			updated: "2026-04-22T10:00:00Z",
		}),
	];

	test("default state is open (filters dismissed alerts)", () => {
		const withDismissed = [
			...records,
			rec("dismissed1", {
				type: "github_dependabot_alert",
				repo: "x/y",
				severity: "high",
				state: "dismissed",
				updated: "2026-04-21T10:00:00Z",
			}),
		];
		const out = queryEntities(withDismissed, { type: "github-dependabot" });
		expect(out.map((r) => r.path)).not.toContain("dismissed1");
	});

	test("severity=high filters to high only", () => {
		const out = queryEntities(records, {
			type: "github-dependabot",
			severity: "high",
		});
		expect(out.map((r) => r.path)).toEqual(["high1"]);
	});

	test("default sort is severity-desc then updated-desc", () => {
		const out = queryEntities(records, { type: "github-dependabot" });
		expect(out.map((r) => r.path)).toEqual(["crit1", "high1", "low1"]);
	});

	test("ecosystem filter", () => {
		const out = queryEntities(records, {
			type: "github-dependabot",
			ecosystem: "npm",
		});
		expect(out.map((r) => r.path).sort()).toEqual(["high1", "low1"]);
	});
});

describe("queryEntities -- edge cases", () => {
	test("empty input returns empty output", () => {
		expect(queryEntities([], { type: "github-issue" })).toEqual([]);
	});

	test("non-string frontmatter values do not crash filters", () => {
		const records = [
			rec("bad", {
				type: "github_issue",
				repo: 123,
				state: null,
				labels: "not-a-list",
				updated: undefined,
			}),
		];
		// Should not throw; records that fail strict checks are simply excluded.
		expect(() =>
			queryEntities(records, { type: "github-issue", state: "open" }),
		).not.toThrow();
	});

	test("malformed updated timestamp treated as epoch 0", () => {
		const records: EntityRecord[] = [
			rec("a", {
				type: "github_issue",
				updated: "not a date",
				number: 1,
			}),
			rec("b", {
				type: "github_issue",
				updated: "2026-04-22T10:00:00Z",
				number: 2,
			}),
		];
		const out = queryEntities(records, {
			type: "github-issue",
			sort: "updated-desc",
		});
		expect(out.map((r) => r.path)).toEqual(["b", "a"]);
	});
});
