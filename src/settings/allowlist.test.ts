import {
	addRepoToAllowlist,
	canonicalizeRepoEntry,
	isRepoAllowlisted,
	removeRepoFromAllowlist,
} from "./allowlist";

describe("canonicalizeRepoEntry", () => {
	test("lowercases and trims", () => {
		expect(canonicalizeRepoEntry("  Bit-Incarnas/Eden  ")).toBe(
			"bit-incarnas/eden",
		);
	});
});

describe("addRepoToAllowlist", () => {
	test("adds a valid entry, canonicalized", () => {
		const result = addRepoToAllowlist([], "Bit-Incarnas/Eden");
		expect(result.added).toBe(true);
		expect(result.canonical).toBe("bit-incarnas/eden");
		expect(result.list).toEqual(["bit-incarnas/eden"]);
	});

	test("preserves input array (immutable)", () => {
		const input = ["a/b"];
		const result = addRepoToAllowlist(input, "c/d");
		expect(result.list).not.toBe(input);
		expect(input).toEqual(["a/b"]);
	});

	test("maintains sorted order", () => {
		let list: string[] = [];
		for (const entry of ["z/z", "a/a", "m/m"]) {
			list = addRepoToAllowlist(list, entry).list;
		}
		expect(list).toEqual(["a/a", "m/m", "z/z"]);
	});

	test("rejects empty input", () => {
		const result = addRepoToAllowlist([], "");
		expect(result.added).toBe(false);
		expect(result.reason).toMatch(/enter an owner/i);
	});

	test("rejects whitespace-only input", () => {
		const result = addRepoToAllowlist([], "   ");
		expect(result.added).toBe(false);
	});

	test("rejects malformed input (missing slash)", () => {
		const result = addRepoToAllowlist([], "noslash");
		expect(result.added).toBe(false);
		expect(result.reason).toMatch(/owner\/repo/i);
	});

	test("rejects malformed owner (contains dot)", () => {
		const result = addRepoToAllowlist([], "foo.bar/repo");
		expect(result.added).toBe(false);
		expect(result.reason).toMatch(/owner/i);
	});

	test("rejects duplicate (case-insensitive)", () => {
		const list = ["bit-incarnas/eden"];
		const result = addRepoToAllowlist(list, "BIT-INCARNAS/EDEN");
		expect(result.added).toBe(false);
		expect(result.reason).toMatch(/already/i);
		expect(result.list).toEqual(list); // unchanged
	});

	test("handles trailing whitespace without adding duplicates", () => {
		const list = ["a/b"];
		const result = addRepoToAllowlist(list, "  a/b  ");
		expect(result.added).toBe(false);
		expect(result.reason).toMatch(/already/i);
	});
});

describe("removeRepoFromAllowlist", () => {
	test("removes the entry", () => {
		const list = ["a/b", "c/d"];
		expect(removeRepoFromAllowlist(list, "a/b")).toEqual(["c/d"]);
	});

	test("removes case-insensitively", () => {
		const list = ["bit-incarnas/eden"];
		expect(removeRepoFromAllowlist(list, "BIT-Incarnas/Eden")).toEqual([]);
	});

	test("no-op when entry is not present", () => {
		const list = ["a/b"];
		expect(removeRepoFromAllowlist(list, "x/y")).toEqual(["a/b"]);
	});

	test("preserves input (immutable)", () => {
		const input = ["a/b", "c/d"];
		const result = removeRepoFromAllowlist(input, "a/b");
		expect(result).not.toBe(input);
		expect(input).toEqual(["a/b", "c/d"]);
	});
});

describe("isRepoAllowlisted", () => {
	test("true when entry present (exact case)", () => {
		expect(isRepoAllowlisted(["a/b"], "a/b")).toBe(true);
	});

	test("true case-insensitively", () => {
		expect(isRepoAllowlisted(["bit-incarnas/eden"], "BIT-INCARNAS/EDEN")).toBe(
			true,
		);
	});

	test("false when absent", () => {
		expect(isRepoAllowlisted(["a/b"], "c/d")).toBe(false);
	});

	test("handles whitespace tolerantly", () => {
		expect(isRepoAllowlisted(["a/b"], "  a/b  ")).toBe(true);
	});

	test("false on empty allowlist", () => {
		expect(isRepoAllowlisted([], "a/b")).toBe(false);
	});
});
