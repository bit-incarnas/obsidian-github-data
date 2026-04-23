/**
 * Middle-ground markdown body sanitizer for GitHub-sourced content.
 *
 * Applied to every issue body, PR description, comment, and README
 * before the content is written into the vault. Purpose: defeat the
 * RCE / exfiltration surface that arises when *other* installed
 * plugins (Templater, Dataview, etc.) auto-process markdown files
 * the vault picked up.
 *
 * From Security Invariants -- Markdown body sanitation (H1). Cap's
 * triage: middle-ground (this module). Block the execution vectors;
 * preserve everything readable.
 *
 * Passes split into two categories:
 *
 * User-safety (toggleable via `disableUserSafetySanitation`):
 * - <script>, <iframe>, <object>, <embed>, <link>, <style> tags stripped
 * - Event-handler attributes (on*) stripped
 * - `javascript:` and `data:text/html` URL schemes stripped
 * - <img> tags rewritten to markdown image form (stricter renderer)
 * - Templater markers `<% ... %>` and `<%* ... %>` literal-escaped
 *   (critical: Templater auto-trigger can RCE from synced bodies)
 * - Dataview inline queries `` `= ... ` `` and `` `$= ... ` `` escaped
 *
 * Vault-integrity (ALWAYS runs, not toggleable):
 * - Wikilinks containing `..` rewritten to prevent path-escape
 * - Persist-block markers `{% persist:* ... %}` escaped so hostile
 *   content cannot inject a preserved region
 *
 * The user-safety passes defend the *operator* from RCE / exfil via
 * other installed plugins. The vault-integrity passes defend the
 * *vault graph* from resolving unexpected paths or corrupting the
 * persist-block extractor. Only the first set is user-disableable.
 *
 * Preserved:
 * - Standard markdown (headings, lists, emphasis, code fences)
 * - Regular wikilinks and embeds (after the `..` rewrite)
 * - Comment bot output (bot identity verified separately)
 */

export interface SanitizeOptions {
	/**
	 * Bypass the user-safety passes. Vault-integrity passes still run.
	 * Default false. When true, the caller accepts that Templater,
	 * Dataview, and raw HTML (script / iframe / event handlers) from
	 * GitHub body content will be written to disk verbatim.
	 */
	disableUserSafetySanitation?: boolean;
}

/**
 * User-safety passes, in order. Blocks the RCE / exfil surface that
 * arises when other installed plugins auto-process synced markdown.
 */
export function sanitizeForUserSafety(input: string): string {
	if (input.length === 0) return input;

	let out = input;
	out = rewriteImgTagsToMarkdown(out);
	out = stripDangerousTags(out);
	out = stripEventHandlerAttributes(out);
	out = stripDangerousUrlSchemes(out);
	out = neutralizeTemplaterMarkers(out);
	out = neutralizeDataviewInlineQueries(out);
	return out;
}

/**
 * Vault-integrity passes, in order. Runs unconditionally; protects the
 * vault graph from path-escape and the persist-block extractor from
 * hostile injection, independent of what the operator chooses to
 * tolerate from upstream.
 */
export function sanitizeForVaultIntegrity(input: string): string {
	if (input.length === 0) return input;

	let out = input;
	out = neutralizeWikilinkDotDot(out);
	out = escapePersistMarkers(out);
	return out;
}

/** Public entry point used by every writer. */
export function sanitizeGithubMarkdown(
	input: string,
	opts: SanitizeOptions = {},
): string {
	if (input.length === 0) return input;
	const afterSafety = opts.disableUserSafetySanitation
		? input
		: sanitizeForUserSafety(input);
	return sanitizeForVaultIntegrity(afterSafety);
}

/**
 * HTML tags whose presence in rendered markdown enables active
 * behavior (script execution, iframe nav, arbitrary style). Stripped
 * outright; the inner content is dropped because a `<style>` block's
 * content is CSS, not user-readable content.
 *
 * Open tags without a closing tag (e.g., `<script src="...">` self-
 * injected) are also matched.
 */
const DANGEROUS_TAGS = [
	"script",
	"iframe",
	"object",
	"embed",
	"link",
	"style",
	"meta",
	"base",
];

export function stripDangerousTags(input: string): string {
	let out = input;
	for (const tag of DANGEROUS_TAGS) {
		// Paired form: <tag>...</tag> across multiple lines, case-insensitive.
		const paired = new RegExp(
			`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`,
			"gi",
		);
		out = out.replace(paired, "");
		// Self-closing or unclosed form.
		const bare = new RegExp(`<${tag}\\b[^>]*\\/?\\s*>`, "gi");
		out = out.replace(bare, "");
	}
	return out;
}

/**
 * Strip `on*` attributes from any tag. Matches `onerror="..."`,
 * `onclick='...'`, `onmouseover=foo` (unquoted) equally.
 */
export function stripEventHandlerAttributes(input: string): string {
	// Walk each tag; inside the tag, strip on* attributes.
	return input.replace(
		/<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g,
		(_full, tagName: string, attrs: string) => {
			const cleanedAttrs = attrs.replace(
				// Match on<word>=<value> where value is quoted or a single
				// non-whitespace token.
				/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
				"",
			);
			return `<${tagName}${cleanedAttrs}>`;
		},
	);
}

/**
 * Strip `javascript:` and `data:text/html` URL schemes from `href` /
 * `src` attributes. Other `data:` variants (e.g., `data:image/png`) are
 * preserved.
 */
export function stripDangerousUrlSchemes(input: string): string {
	// href="javascript:..." or src='data:text/html,...'
	return input.replace(
		/\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
		(full, attr: string, quoted: string, single: string, bare: string) => {
			const raw = quoted ?? single ?? bare ?? "";
			const trimmed = raw.trim().toLowerCase();
			if (
				trimmed.startsWith("javascript:") ||
				trimmed.startsWith("data:text/html")
			) {
				return "";
			}
			return full;
		},
	);
}

/**
 * Rewrite `<img ...>` tags to markdown image form `![alt](src)` when
 * possible. Markdown image rendering is stricter about URL schemes
 * than raw `<img>`, and Obsidian'd markdown renderer declines
 * `javascript:` / `data:text/html` on markdown images reliably.
 */
export function rewriteImgTagsToMarkdown(input: string): string {
	return input.replace(
		/<img\b([^>]*?)\/?\s*>/gi,
		(full, attrs: string) => {
			const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(
				attrs,
			);
			const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(
				attrs,
			);
			if (!srcMatch) return ""; // broken img, drop it
			const src = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "";
			const alt = altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "";
			return `![${alt}](${src})`;
		},
	);
}

/**
 * Neutralize Templater markers. `<% ... %>` and `<%* ... %>` are
 * matched by Templater's processor; we backslash-escape the opening
 * `<` so the sequence renders visibly as `<%` but Templater's regex
 * finds no match.
 *
 * Replacement is `\<%` which, in markdown reading mode, displays as
 * `<%` (markdown eats the backslash before a non-special char but
 * treats `<` as literal).
 */
export function neutralizeTemplaterMarkers(input: string): string {
	return input.replace(/<%/g, "\\<%");
}

/**
 * Neutralize Dataview inline queries: `` `=expr` `` (expression) and
 * `` `$=js` `` (DataviewJS). Escape the opening backtick so the inline
 * query is rendered as literal code span text rather than executed.
 */
export function neutralizeDataviewInlineQueries(input: string): string {
	// Match the opening backtick + = or $= at the start of an inline span.
	return input.replace(/`([=$])/g, "\\`$1");
}

/**
 * Rewrite wikilinks containing `..` to plain text. Prevents a hostile
 * body from dropping a `[[../../etc]]` reference that resolves
 * unexpectedly on some renderers.
 */
export function neutralizeWikilinkDotDot(input: string): string {
	return input.replace(
		/\[\[([^\]]*\.\.[^\]]*)\]\]/g,
		(_match, inner: string) => `[[${inner.replace(/\.\./g, ".")}]]`,
	);
}

/**
 * Escape persist-block markers in GitHub-sourced content so attackers
 * cannot inject a block that survives sync regeneration.
 *
 * Escape form: `{% persist:user ... %}` -> `{\% persist:user ... %}`.
 * Markdown renders `{\%` as `{%` so readability is preserved, and the
 * persist-extractor regex (which looks for `{%\s*persist:...`) fails
 * to match.
 */
export function escapePersistMarkers(input: string): string {
	return input
		.replace(/\{%\s*persist:user\b/g, "{\\% persist:user")
		.replace(/\{%\s*persist:template\b/g, "{\\% persist:template")
		.replace(/\{%\s*endpersist\s*%\}/g, "{\\% endpersist %}");
}
