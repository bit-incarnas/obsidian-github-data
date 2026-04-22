/**
 * Pure helpers for the repo allowlist -- kept separate from the UI so
 * the add/remove/dedup logic stays testable without a DOM.
 *
 * Allowlist entries are canonicalized as lowercase `owner/repo`
 * strings. GitHub is case-insensitive for owner/repo comparison, so
 * storing a canonical form prevents silent duplicates (e.g.,
 * `BIT-Incarnas/Eden` vs `bit-incarnas/eden`).
 */

import { parseRepoPath } from "../paths/sanitize";

export interface AddRepoResult {
	list: string[];
	added: boolean;
	reason?: string;
	canonical?: string;
}

export function canonicalizeRepoEntry(entry: string): string {
	return entry.trim().toLowerCase();
}

/**
 * Validate + canonicalize + dedup-insert. Returns a new array (never
 * mutates the input).
 */
export function addRepoToAllowlist(
	list: string[],
	entry: string,
): AddRepoResult {
	const trimmed = entry.trim();
	if (trimmed.length === 0) {
		return { list, added: false, reason: "Enter an owner/repo string." };
	}

	const parsed = parseRepoPath(trimmed);
	if (!parsed.valid) {
		return {
			list,
			added: false,
			reason: parsed.reason ?? "Invalid owner/repo format.",
		};
	}

	const canonical = canonicalizeRepoEntry(`${parsed.owner}/${parsed.repo}`);
	if (list.some((existing) => canonicalizeRepoEntry(existing) === canonical)) {
		return {
			list,
			added: false,
			canonical,
			reason: `Already in allowlist: ${canonical}`,
		};
	}

	return {
		list: [...list, canonical].sort((a, b) => a.localeCompare(b)),
		added: true,
		canonical,
	};
}

export function removeRepoFromAllowlist(
	list: string[],
	entry: string,
): string[] {
	const canonical = canonicalizeRepoEntry(entry);
	return list.filter((e) => canonicalizeRepoEntry(e) !== canonical);
}

/**
 * Is a given repo spec in the allowlist? Case-insensitive.
 *
 * Used by the codeblock processor and sync engine to enforce the
 * allowlist at call time (Security Invariant H3 -- codeblock execution).
 */
export function isRepoAllowlisted(
	list: string[],
	entry: string,
): boolean {
	const canonical = canonicalizeRepoEntry(entry);
	return list.some((e) => canonicalizeRepoEntry(e) === canonical);
}
