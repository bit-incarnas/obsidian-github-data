/**
 * Persist-block extraction + merge.
 *
 * Pattern lifted conceptually from LonoxX/obsidian-github-issues and
 * upstream from mgmeyers/obsidian-zotero-integration (both MIT; see
 * NOTICES for provenance). Our implementation is namespaced per the
 * Security Invariants: user-authored blocks are kept across syncs,
 * template-authored blocks are transient.
 *
 * Format:
 *   {% persist:user "name" %}
 *   ... user-authored content preserved across sync ...
 *   {% endpersist %}
 *
 *   {% persist:template "name" %}
 *   ... template placeholder; always replaced by the writer ...
 *   {% endpersist %}
 *
 * Security Invariant anchors:
 * - H2 (persist-block injection): we only *extract* `persist:user`
 *   blocks when merging; `persist:template` blocks are never
 *   preserved. GitHub-sourced content passes through `escapePersistMarkers`
 *   in src/sanitize/body.ts before landing in the vault, so hostile
 *   content cannot plant a `persist:user` block on first sync.
 * - Detection: `looksGithubSourced(content)` flags preserved blocks
 *   that appear to contain API-origin text, so the writer can surface
 *   a warning.
 *
 * API shape is intentionally simple:
 * - `extractPersistBlocks(text)` finds user blocks in an existing file
 * - `mergePersistBlocks(newText, savedBlocks)` composes a fresh body
 *   with saved-block content substituted in
 *
 * Non-goals for v0.1:
 * - No context-line fuzzy matching (LonoxX's approach). The writer
 *   controls template positions, so same-name substitution is enough.
 * - No warning on orphaned blocks (blocks in save but not in new
 *   template). They are appended at end of body before the NAV footer.
 */

export interface PersistBlock {
	name: string;
	kind: "user" | "template";
	content: string;
	/** Start offset of the `{% persist:... %}` marker in source. */
	startIndex: number;
	/** End offset of the `{% endpersist %}` marker in source. */
	endIndex: number;
	/** Original text between markers (no wrapping markers). */
	originalFull: string;
}

const PERSIST_REGEX =
	/\{%\s*persist:(user|template)\s+"([^"]+)"\s*%\}([\s\S]*?)\{%\s*endpersist\s*%\}/g;

/**
 * Extract `persist:user` blocks from `text`. Returns them in source
 * order. `persist:template` blocks are excluded -- they never survive
 * regeneration.
 */
export function extractPersistBlocks(text: string): PersistBlock[] {
	const result: PersistBlock[] = [];
	let match: RegExpExecArray | null;
	PERSIST_REGEX.lastIndex = 0;
	while ((match = PERSIST_REGEX.exec(text)) !== null) {
		const kind = match[1] as "user" | "template";
		if (kind !== "user") continue;
		result.push({
			name: match[2],
			kind,
			content: match[3],
			startIndex: match.index,
			endIndex: match.index + match[0].length,
			originalFull: match[0],
		});
	}
	return result;
}

/**
 * Substitute saved user-block content into a fresh body. Where the new
 * body declares a `persist:user "name"` slot, its content is replaced
 * by the saved block of the same name.
 *
 * Saved blocks that don't appear in `newText` are preserved by
 * appending them at the end (before a `## :: NAV` footer if present).
 * This prevents silent loss when the template evolves.
 */
export function mergePersistBlocks(
	newText: string,
	saved: PersistBlock[],
): string {
	if (saved.length === 0) return newText;

	const byName = new Map<string, PersistBlock>();
	for (const block of saved) byName.set(block.name, block);
	const usedNames = new Set<string>();

	// Substitute matching blocks.
	const substituted = newText.replace(
		PERSIST_REGEX,
		(full, kind: string, name: string, templateContent: string) => {
			if (kind !== "user") return full;
			const savedBlock = byName.get(name);
			if (!savedBlock) return full;
			usedNames.add(name);
			return `{% persist:user "${name}" %}${savedBlock.content}{% endpersist %}`;
		},
	);

	// Find orphans (saved but not present in new body).
	const orphans = saved.filter((block) => !usedNames.has(block.name));
	if (orphans.length === 0) return substituted;

	const orphanSection = buildOrphanSection(orphans);
	return insertOrphanSection(substituted, orphanSection);
}

function buildOrphanSection(orphans: PersistBlock[]): string {
	const lines: string[] = [];
	lines.push("");
	lines.push(
		"<!-- persist-block orphans preserved from a previous version of this file -->",
	);
	lines.push(
		"<!-- the template no longer emits these blocks; move them to a desired spot if you want to keep them -->",
	);
	for (const block of orphans) {
		lines.push("");
		lines.push(`{% persist:user "${block.name}" %}${block.content}{% endpersist %}`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Insert the orphan section just before a `## :: NAV` footer if one
 * exists, else append to the end of the document.
 */
function insertOrphanSection(body: string, orphanSection: string): string {
	const navMatch = /\n---\s*\n## :: NAV\b/.exec(body);
	if (navMatch) {
		const insertAt = navMatch.index;
		return (
			body.slice(0, insertAt) + orphanSection + body.slice(insertAt)
		);
	}
	return body.endsWith("\n") ? `${body}${orphanSection}` : `${body}\n${orphanSection}`;
}

/**
 * Heuristic check: does this content look like it was sourced from
 * GitHub (rather than hand-authored by the user)? Used as a weak
 * tripwire in the writer: if a preserved block matches these patterns,
 * surface a notice -- possibly indicates an attacker injected a block
 * via GitHub content that slipped past the sanitizer.
 *
 * Intentionally conservative (false positives OK, false negatives
 * dangerous): returns true if the content starts with a GitHub-
 * conventional token like `@user:`, `#\d+`, or an ISO-style timestamp.
 */
export function looksGithubSourced(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length === 0) return false;
	if (/^@[a-zA-Z0-9_-]+:/m.test(trimmed)) return true;
	if (/^#\d+\b/m.test(trimmed)) return true;
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/m.test(trimmed)) return true;
	return false;
}

/**
 * Convenience: build a canonical empty `persist:user` block for a
 * template writer to embed. Keeps marker formatting consistent across
 * callers.
 */
export function userPersistBlock(name: string, initial = ""): string {
	return `{% persist:user "${name}" %}\n${initial}\n{% endpersist %}`;
}
