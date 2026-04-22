/**
 * Path-segment sanitation + containment utilities.
 *
 * Every filesystem path segment derived from a GitHub-sourced name
 * (owner, repo, tag, slug) passes through these helpers before being
 * concatenated into a vault path. Rationale is in 01_DESIGN.md Security
 * Invariants -- Path construction (C1 from the pre-implementation
 * security review).
 *
 * Defenses layered here:
 * - Unicode normalization (NFKC) collapses compatibility characters.
 * - ASCII whitelist rejects non-whitelist characters -- including
 *   Cyrillic / Greek homoglyphs (`а` Cyrillic vs `a` Latin both
 *   visually identical; only Latin passes the whitelist).
 * - Leading / trailing dots stripped (prevents `.git`, `.ssh`, etc.
 *   creating dotfiles; prevents `foo.` -> `foo` collision on
 *   case-insensitive Windows).
 * - Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
 *   prefixed with `_` so they become legal on Windows.
 * - Length cap prevents surprise-long paths that blow past Windows'
 *   MAX_PATH.
 * - Empty results collapse to a fallback literal rather than producing
 *   an empty segment that would break join semantics.
 * - Lowercase default so case-insensitive filesystems (macOS HFS+/APFS
 *   defaults; Windows NTFS always) don't silently collide.
 *
 * The GitHub naming-rule validator (`validateRepoName`) is a belt on
 * top of this suspenders layer: reject malformed inputs early so the
 * plugin never writes to unexpected paths even if the sanitizer is
 * changed later.
 */

export interface SanitizeOptions {
	/** Max characters in the resulting segment. Default 60. */
	maxLength?: number;
	/** Lowercase output for case-insensitive FS safety. Default true. */
	lowercase?: boolean;
	/** Fallback string when sanitation results in an empty segment. Default "unknown". */
	fallback?: string;
}

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function sanitizePathSegment(
	input: string,
	options: SanitizeOptions = {},
): string {
	const maxLength = options.maxLength ?? 60;
	const lowercase = options.lowercase ?? true;
	const fallback = options.fallback ?? "unknown";

	let out = input.normalize("NFKC");
	// Whitelist: letters, digits, dot, dash, underscore. Everything else -> dash.
	out = out.replace(/[^A-Za-z0-9._-]/g, "-");
	// Collapse runs of dashes introduced by the replacement pass.
	out = out.replace(/-+/g, "-");
	// Strip leading/trailing dots and dashes.
	out = out.replace(/^[.\-]+/, "").replace(/[.\-]+$/, "");
	// Escape Windows reserved names.
	if (WINDOWS_RESERVED.test(out)) {
		out = `_${out}`;
	}
	if (out.length > maxLength) {
		out = out.slice(0, maxLength);
		// Re-strip trailing dots/dashes that may now sit at the slice boundary.
		out = out.replace(/[.\-]+$/, "");
	}
	if (out.length === 0) {
		out = fallback;
	}
	return lowercase ? out.toLowerCase() : out;
}

/**
 * Convert a free-form title into a filesystem-safe slug. Used for
 * issue/PR filenames where we have a numeric ID and want a readable
 * tail. Distinct from `sanitizePathSegment` because titles commonly
 * include spaces -> dashes transformation.
 */
export function slugifyTitle(title: string, maxLength = 50): string {
	const nfkc = title.normalize("NFKC").toLowerCase();
	const slug = nfkc
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/, ""); // slice may leave a trailing dash
	return slug.length > 0 ? slug : "untitled";
}

/**
 * Compose a `{owner}__{repo}` folder name with each segment pre-
 * sanitized. Using a double-underscore separator avoids collision
 * with the single underscores GitHub permits inside repo names.
 */
export function composeRepoFolderName(owner: string, repo: string): string {
	return `${sanitizePathSegment(owner)}__${sanitizePathSegment(repo)}`;
}

/**
 * Issue / PR filename in the canonical `{number}-{slug}.md` form.
 */
export function issueFilename(number: number, title: string): string {
	return `${number}-${slugifyTitle(title)}.md`;
}

/**
 * GitHub's actual naming rules. Use before trusting external input as
 * a path segment source; even with the sanitizer, we don't want to
 * silently accept API responses that violate GitHub's own contract.
 */
const GITHUB_OWNER = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$/;
/** Repos allow letters, digits, dot, dash, underscore; 1-100 chars. */
const GITHUB_REPO = /^(?!\.+$)[a-zA-Z0-9._-]{1,100}$/;

export interface RepoNameValidation {
	valid: boolean;
	owner: string;
	repo: string;
	reason?: string;
}

export function validateRepoName(
	owner: string,
	repo: string,
): RepoNameValidation {
	if (!GITHUB_OWNER.test(owner)) {
		return { valid: false, owner, repo, reason: `Invalid owner: "${owner}"` };
	}
	if (!GITHUB_REPO.test(repo)) {
		return { valid: false, owner, repo, reason: `Invalid repo: "${repo}"` };
	}
	return { valid: true, owner, repo };
}

/**
 * Parse an `owner/repo` string into its components. Returns
 * `{valid: false}` if the shape is wrong or either component fails
 * validation.
 */
export function parseRepoPath(full: string): RepoNameValidation {
	const parts = full.split("/");
	if (parts.length !== 2) {
		return {
			valid: false,
			owner: "",
			repo: "",
			reason: `Expected "owner/repo", got "${full}"`,
		};
	}
	return validateRepoName(parts[0], parts[1]);
}

/**
 * Normalize a POSIX-style path: resolve `.` and `..` segments, collapse
 * repeated slashes. Preserves a leading `/` for absolute paths.
 *
 * Intentionally does not touch Windows `\` -- all vault paths use `/`.
 */
export function normalizePath(input: string): string {
	const isAbsolute = input.startsWith("/");
	const segments = input.split("/").filter((s) => s.length > 0);
	const stack: string[] = [];
	for (const seg of segments) {
		if (seg === ".") continue;
		if (seg === "..") {
			if (stack.length > 0) stack.pop();
			continue;
		}
		stack.push(seg);
	}
	const joined = stack.join("/");
	return isAbsolute ? `/${joined}` : joined;
}

/**
 * Assert that `child` (composed path) is contained inside `parent`
 * (expected root). Handles edge cases:
 * - exact equality returns true
 * - `/root` vs `/root-other` correctly returns false (separator check)
 * - normalizes both sides before comparison
 */
export function isPathInside(child: string, parent: string): boolean {
	const normChild = normalizePath(child).replace(/\/+$/, "");
	const normParent = normalizePath(parent).replace(/\/+$/, "");
	if (normChild === normParent) return true;
	return normChild.startsWith(`${normParent}/`);
}

export interface JoinResult {
	ok: boolean;
	path?: string;
	reason?: string;
}

/**
 * Join segments under a root and assert containment. Segments are
 * treated as literal (already-sanitized); use `sanitizePathSegment`
 * upstream if they come from untrusted sources.
 */
export function joinInsideRoot(
	root: string,
	...segments: string[]
): JoinResult {
	const normRoot = normalizePath(root).replace(/\/+$/, "");
	const joined = normalizePath(`${normRoot}/${segments.join("/")}`);
	if (!isPathInside(joined, normRoot)) {
		return { ok: false, reason: `Path escape detected: "${joined}" not inside "${normRoot}"` };
	}
	return { ok: true, path: joined };
}
