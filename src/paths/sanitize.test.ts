import {
	composeRepoFolderName,
	isPathInside,
	issueFilename,
	joinInsideRoot,
	normalizePath,
	parseRepoPath,
	sanitizePathSegment,
	slugifyTitle,
	validateRepoName,
} from "./sanitize";

describe("sanitizePathSegment", () => {
	test("passes through basic ASCII alphanumerics", () => {
		expect(sanitizePathSegment("bit-incarnas")).toBe("bit-incarnas");
	});

	test("lowercases by default", () => {
		expect(sanitizePathSegment("MixedCase")).toBe("mixedcase");
	});

	test("can preserve case when lowercase=false", () => {
		expect(sanitizePathSegment("MixedCase", { lowercase: false })).toBe(
			"MixedCase",
		);
	});

	test("replaces slashes with dash", () => {
		expect(sanitizePathSegment("foo/bar")).toBe("foo-bar");
	});

	test("replaces backslashes with dash", () => {
		expect(sanitizePathSegment("foo\\bar")).toBe("foo-bar");
	});

	test("collapses runs of dashes introduced by sanitation", () => {
		expect(sanitizePathSegment("a   b")).toBe("a-b");
		expect(sanitizePathSegment("a///b")).toBe("a-b");
	});

	test("strips leading dots", () => {
		expect(sanitizePathSegment(".github")).toBe("github");
		expect(sanitizePathSegment("...hidden")).toBe("hidden");
	});

	test("strips trailing dots", () => {
		expect(sanitizePathSegment("foo.")).toBe("foo");
		expect(sanitizePathSegment("foo...")).toBe("foo");
	});

	test("pure-dot input collapses to fallback", () => {
		expect(sanitizePathSegment(".")).toBe("unknown");
		expect(sanitizePathSegment("..")).toBe("unknown");
		expect(sanitizePathSegment("....")).toBe("unknown");
	});

	test("escapes Windows reserved names with underscore prefix", () => {
		expect(sanitizePathSegment("CON")).toBe("_con");
		expect(sanitizePathSegment("PRN")).toBe("_prn");
		expect(sanitizePathSegment("NUL")).toBe("_nul");
		expect(sanitizePathSegment("AUX")).toBe("_aux");
		expect(sanitizePathSegment("COM1")).toBe("_com1");
		expect(sanitizePathSegment("LPT9")).toBe("_lpt9");
	});

	test("escapes reserved names with extension too", () => {
		expect(sanitizePathSegment("CON.txt")).toBe("_con.txt");
		expect(sanitizePathSegment("NUL.log")).toBe("_nul.log");
	});

	test("reserved-name detection is case-insensitive", () => {
		expect(sanitizePathSegment("con")).toBe("_con");
		expect(sanitizePathSegment("Com5")).toBe("_com5");
	});

	test("Cyrillic homoglyphs get replaced (not pass through)", () => {
		// "а" here is Cyrillic U+0430, not Latin "a" U+0061
		const cyrillic = "bit-incarnаs";
		expect(sanitizePathSegment(cyrillic)).toBe("bit-incarn-s");
	});

	test("NFKC collapses compatibility characters", () => {
		// ﬁ (U+FB01) is the "fi" ligature; NFKC decomposes to "fi"
		expect(sanitizePathSegment("ﬁle")).toBe("file");
		// ㎥ (U+33A5) is "m" + superscript-3; NFKC decomposes to "m3"
		expect(sanitizePathSegment("㎥")).toBe("m3");
	});

	test("unicode emoji gets replaced with dash", () => {
		expect(sanitizePathSegment("repo-\u{1F600}")).toBe("repo");
	});

	test("empty input collapses to fallback", () => {
		expect(sanitizePathSegment("")).toBe("unknown");
	});

	test("only-special-chars collapses to fallback", () => {
		expect(sanitizePathSegment("!@#$%^&*()")).toBe("unknown");
	});

	test("length cap respects maxLength", () => {
		expect(sanitizePathSegment("a".repeat(100))).toHaveLength(60);
		expect(
			sanitizePathSegment("a".repeat(100), { maxLength: 10 }),
		).toHaveLength(10);
	});

	test("length cap re-strips trailing dots/dashes after slice", () => {
		// Input: "aaaa-----something" truncated to 10 = "aaaa-----s" -> no trailing issue
		// Input crafted so the slice ends on a dash
		const result = sanitizePathSegment("a".repeat(8) + "-".repeat(5), {
			maxLength: 10,
		});
		expect(result).not.toMatch(/[.\-]$/);
	});

	test("custom fallback string", () => {
		expect(sanitizePathSegment("", { fallback: "empty" })).toBe("empty");
	});
});

describe("slugifyTitle", () => {
	test("lowercases + replaces non-alphanumeric with dashes", () => {
		expect(slugifyTitle("Fix Bug In Login")).toBe("fix-bug-in-login");
	});

	test("collapses runs of special chars to single dash", () => {
		expect(slugifyTitle("Fix: bug #42 -- <critical>")).toBe(
			"fix-bug-42-critical",
		);
	});

	test("strips leading and trailing dashes", () => {
		expect(slugifyTitle("-- leading --")).toBe("leading");
	});

	test("empty input returns 'untitled'", () => {
		expect(slugifyTitle("")).toBe("untitled");
	});

	test("only-special-chars returns 'untitled'", () => {
		expect(slugifyTitle("!@#$%")).toBe("untitled");
		expect(slugifyTitle("----")).toBe("untitled");
	});

	test("length cap respects maxLength", () => {
		const long = "a".repeat(100);
		expect(slugifyTitle(long)).toHaveLength(50);
		expect(slugifyTitle(long, 10)).toHaveLength(10);
	});

	test("length cap re-strips trailing dash after slice", () => {
		// "aaa-bbb-ccc" truncated at 4 becomes "aaa-" -> should strip to "aaa"
		expect(slugifyTitle("aaa bbb ccc", 4)).toBe("aaa");
	});

	test("unicode NFKC normalization applies", () => {
		expect(slugifyTitle("ﬁrst")).toBe("first"); // ﬁ ligature
	});
});

describe("composeRepoFolderName", () => {
	test("standard owner/repo", () => {
		expect(composeRepoFolderName("bit-incarnas", "eden")).toBe(
			"bit-incarnas__eden",
		);
	});

	test("sanitizes hostile owner", () => {
		expect(composeRepoFolderName("../etc", "repo")).toBe("etc__repo");
	});
});

describe("issueFilename", () => {
	test("canonical form", () => {
		expect(issueFilename(42, "Fix bug in login")).toBe(
			"42-fix-bug-in-login.md",
		);
	});

	test("empty title falls back to 'untitled'", () => {
		expect(issueFilename(7, "")).toBe("7-untitled.md");
	});
});

describe("validateRepoName", () => {
	test("accepts standard owner/repo", () => {
		const result = validateRepoName("bit-incarnas", "obsidian-github-data");
		expect(result.valid).toBe(true);
	});

	test("rejects owner with dots", () => {
		const result = validateRepoName("foo.bar", "repo");
		expect(result.valid).toBe(false);
		expect(result.reason).toMatch(/owner/i);
	});

	test("rejects owner with leading dash", () => {
		const result = validateRepoName("-foo", "repo");
		expect(result.valid).toBe(false);
	});

	test("rejects owner with consecutive dashes", () => {
		const result = validateRepoName("foo--bar", "repo");
		expect(result.valid).toBe(false);
	});

	test("accepts repo with dots, dashes, underscores", () => {
		const result = validateRepoName("owner", "my.cool-repo_v2");
		expect(result.valid).toBe(true);
	});

	test("rejects repo '.' and '..'", () => {
		expect(validateRepoName("owner", ".").valid).toBe(false);
		expect(validateRepoName("owner", "..").valid).toBe(false);
	});

	test("rejects repo with slash", () => {
		expect(validateRepoName("owner", "foo/bar").valid).toBe(false);
	});

	test("rejects empty", () => {
		expect(validateRepoName("", "repo").valid).toBe(false);
		expect(validateRepoName("owner", "").valid).toBe(false);
	});
});

describe("parseRepoPath", () => {
	test("parses valid owner/repo", () => {
		const result = parseRepoPath("bit-incarnas/eden");
		expect(result.valid).toBe(true);
		expect(result.owner).toBe("bit-incarnas");
		expect(result.repo).toBe("eden");
	});

	test("rejects missing slash", () => {
		expect(parseRepoPath("noslash").valid).toBe(false);
	});

	test("rejects extra slashes", () => {
		expect(parseRepoPath("a/b/c").valid).toBe(false);
	});

	test("rejects malformed owner", () => {
		expect(parseRepoPath("foo.bar/repo").valid).toBe(false);
	});
});

describe("normalizePath", () => {
	test("passes through clean path", () => {
		expect(normalizePath("/a/b/c")).toBe("/a/b/c");
		expect(normalizePath("a/b/c")).toBe("a/b/c");
	});

	test("resolves '.' segments", () => {
		expect(normalizePath("/a/./b")).toBe("/a/b");
	});

	test("resolves '..' segments", () => {
		expect(normalizePath("/a/b/../c")).toBe("/a/c");
	});

	test("resolves multiple '..' segments", () => {
		expect(normalizePath("/a/b/c/../../d")).toBe("/a/d");
	});

	test("drops excess '..' on relative paths", () => {
		expect(normalizePath("../foo")).toBe("foo");
		expect(normalizePath("a/../../b")).toBe("b");
	});

	test("preserves absolute leading slash", () => {
		expect(normalizePath("/")).toBe("/");
	});

	test("collapses repeated slashes", () => {
		expect(normalizePath("/a///b//c")).toBe("/a/b/c");
	});
});

describe("isPathInside", () => {
	test("direct child", () => {
		expect(isPathInside("/root/a", "/root")).toBe(true);
	});

	test("deep child", () => {
		expect(isPathInside("/root/a/b/c", "/root")).toBe(true);
	});

	test("exact match counts as inside", () => {
		expect(isPathInside("/root", "/root")).toBe(true);
	});

	test("sibling prefix is not inside", () => {
		expect(isPathInside("/root-other/a", "/root")).toBe(false);
	});

	test("parent-relative escape is not inside", () => {
		expect(isPathInside("/root/../other", "/root")).toBe(false);
	});

	test("trailing slash tolerance", () => {
		expect(isPathInside("/root/a/", "/root/")).toBe(true);
	});

	test("relative paths", () => {
		expect(isPathInside("a/b", "a")).toBe(true);
		expect(isPathInside("a/../b", "a")).toBe(false);
	});
});

describe("joinInsideRoot", () => {
	test("happy path returns composed + contained", () => {
		const result = joinInsideRoot(
			"02_AREAS/GitHub",
			"Repos",
			"bit-incarnas__eden",
			"Issues",
			"42-fix.md",
		);
		expect(result.ok).toBe(true);
		expect(result.path).toBe(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Issues/42-fix.md",
		);
	});

	test("rejects path escape via '..' segment", () => {
		const result = joinInsideRoot(
			"02_AREAS/GitHub",
			"..",
			"..",
			"99_ARCHIVE",
			"pwn.md",
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/escape/i);
	});

	test("normalizes trailing slashes on root", () => {
		const result = joinInsideRoot("02_AREAS/GitHub/", "Repos", "foo__bar");
		expect(result.ok).toBe(true);
		expect(result.path).toBe("02_AREAS/GitHub/Repos/foo__bar");
	});
});
