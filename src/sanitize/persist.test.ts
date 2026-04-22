import {
	extractPersistBlocks,
	looksGithubSourced,
	mergePersistBlocks,
	userPersistBlock,
} from "./persist";

describe("extractPersistBlocks", () => {
	test("extracts a single user block", () => {
		const text = `before\n{% persist:user "notes" %}hi\n{% endpersist %}\nafter`;
		const blocks = extractPersistBlocks(text);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			name: "notes",
			kind: "user",
			content: "hi\n",
		});
	});

	test("ignores template blocks", () => {
		const text = `{% persist:template "slot" %}placeholder{% endpersist %}`;
		expect(extractPersistBlocks(text)).toHaveLength(0);
	});

	test("extracts multiple user blocks in source order", () => {
		const text = [
			'{% persist:user "first" %}A{% endpersist %}',
			"middle",
			'{% persist:user "second" %}B{% endpersist %}',
		].join("\n");
		const blocks = extractPersistBlocks(text);
		expect(blocks.map((b) => b.name)).toEqual(["first", "second"]);
		expect(blocks.map((b) => b.content)).toEqual(["A", "B"]);
	});

	test("extracts multiline user content verbatim", () => {
		const text = `{% persist:user "x" %}\nline1\nline2\n{% endpersist %}`;
		const blocks = extractPersistBlocks(text);
		expect(blocks[0].content).toBe("\nline1\nline2\n");
	});

	test("empty content extracts as empty string", () => {
		const text = `{% persist:user "empty" %}{% endpersist %}`;
		expect(extractPersistBlocks(text)[0].content).toBe("");
	});

	test("blocks are returned in source order even mixed with template", () => {
		const text = [
			'{% persist:template "t1" %}T{% endpersist %}',
			'{% persist:user "u1" %}U1{% endpersist %}',
			'{% persist:template "t2" %}T2{% endpersist %}',
			'{% persist:user "u2" %}U2{% endpersist %}',
		].join("\n");
		const blocks = extractPersistBlocks(text);
		expect(blocks.map((b) => b.name)).toEqual(["u1", "u2"]);
	});

	test("no blocks -> empty array", () => {
		expect(extractPersistBlocks("just regular text")).toEqual([]);
	});
});

describe("mergePersistBlocks", () => {
	function mkBlock(name: string, content: string) {
		return {
			name,
			kind: "user" as const,
			content,
			startIndex: 0,
			endIndex: 0,
			originalFull: "",
		};
	}

	test("substitutes matching blocks in new body", () => {
		const newBody = `{% persist:user "notes" %}template default{% endpersist %}`;
		const saved = [mkBlock("notes", "my saved content")];
		const merged = mergePersistBlocks(newBody, saved);
		expect(merged).toContain("my saved content");
		expect(merged).not.toContain("template default");
	});

	test("leaves non-matching user blocks untouched", () => {
		const newBody = `{% persist:user "slot-a" %}default A{% endpersist %}`;
		const saved = [mkBlock("other", "other content")];
		const merged = mergePersistBlocks(newBody, saved);
		expect(merged).toContain("default A");
		// orphan section appended
		expect(merged).toContain('{% persist:user "other" %}other content{% endpersist %}');
	});

	test("leaves template blocks alone even if name matches a saved block", () => {
		// A saved user block named "notes" does NOT substitute into a
		// template block named "notes" -- only persist:user slots are
		// substitution targets. The saved block becomes an orphan since
		// no persist:user slot consumed it.
		const newBody = `{% persist:template "notes" %}NEVER PRESERVE ME{% endpersist %}`;
		const saved = [mkBlock("notes", "saved user content")];
		const merged = mergePersistBlocks(newBody, saved);
		expect(merged).toContain("NEVER PRESERVE ME"); // template intact
		// Saved block preserved as orphan -- safer than silent loss
		expect(merged).toContain('{% persist:user "notes" %}saved user content');
	});

	test("preserves orphaned blocks before NAV footer", () => {
		const newBody = [
			"# header",
			"body text",
			"",
			"---",
			"## :: NAV",
			"[[target]]",
		].join("\n");
		const saved = [mkBlock("my-notes", "preserved!")];
		const merged = mergePersistBlocks(newBody, saved);
		expect(merged).toContain("preserved!");
		// Orphan appears BEFORE the NAV footer
		const notesIdx = merged.indexOf("preserved!");
		const navIdx = merged.indexOf("## :: NAV");
		expect(notesIdx).toBeLessThan(navIdx);
	});

	test("appends orphans to end of doc when no NAV footer", () => {
		const newBody = "# header\nbody";
		const saved = [mkBlock("stray", "orphan")];
		const merged = mergePersistBlocks(newBody, saved);
		expect(merged.endsWith("body")).toBe(false);
		expect(merged).toContain("orphan");
	});

	test("no-op when saved is empty", () => {
		const body = `# h\n{% persist:user "x" %}default{% endpersist %}`;
		expect(mergePersistBlocks(body, [])).toBe(body);
	});

	test("multiple saved blocks substituted independently", () => {
		const newBody = [
			`{% persist:user "a" %}TA{% endpersist %}`,
			`{% persist:user "b" %}TB{% endpersist %}`,
		].join("\n");
		const saved = [mkBlock("a", "SA"), mkBlock("b", "SB")];
		const merged = mergePersistBlocks(newBody, saved);
		expect(merged).toContain("SA");
		expect(merged).toContain("SB");
		expect(merged).not.toContain("TA");
		expect(merged).not.toContain("TB");
	});
});

describe("looksGithubSourced", () => {
	test("flags @user: prefix", () => {
		expect(looksGithubSourced("@octocat: thanks")).toBe(true);
	});

	test("flags #issue-number prefix", () => {
		expect(looksGithubSourced("#42 is the one")).toBe(true);
	});

	test("flags ISO timestamp at start", () => {
		expect(looksGithubSourced("2026-04-22T15:30:00Z: hi")).toBe(true);
	});

	test("clean user notes return false", () => {
		expect(looksGithubSourced("these are my own notes")).toBe(false);
	});

	test("empty content returns false", () => {
		expect(looksGithubSourced("")).toBe(false);
		expect(looksGithubSourced("   \n  ")).toBe(false);
	});
});

describe("userPersistBlock", () => {
	test("produces a canonical empty block", () => {
		expect(userPersistBlock("notes")).toBe(
			'{% persist:user "notes" %}\n\n{% endpersist %}',
		);
	});

	test("includes initial content", () => {
		expect(userPersistBlock("notes", "default")).toBe(
			'{% persist:user "notes" %}\ndefault\n{% endpersist %}',
		);
	});
});
