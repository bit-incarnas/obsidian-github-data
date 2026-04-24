/**
 * Settings schema + defaults.
 *
 * Keep `schemaVersion` bumped on every breaking change so migration is a
 * single versioned function rather than the ad-hoc-branch mess LonoxX
 * ended up with.
 */

export interface GithubDataSettings {
	schemaVersion: number;

	/** Plaintext PAT. Empty when `useSecretStorage` is true. */
	token: string;
	/** True when the PAT lives in Obsidian's SecretStorage API. */
	useSecretStorage: boolean;
	/** Key name inside SecretStorage. Fixed per-plugin; exposed for debug. */
	secretTokenName: string;

	/** One-time flag: whether we've already warned the user that their vault is under git. */
	devVaultGitNoticeShown: boolean;

	/** Allowlist of `owner/repo` strings the plugin is allowed to sync. */
	repoAllowlist: string[];

	/** Background sync cadence in minutes. 0 disables background sync. */
	syncCadenceMinutes: number;

	/**
	 * How many days back from now to include when syncing activity
	 * (commits / PRs / issues / reviews). GitHub's contributionsCollection
	 * caps at 1 year per query; larger windows would need to be split.
	 */
	activitySyncDays: number;

	/** Last successful sync per repo (ISO-8601 UTC). Populated by the sync engine. */
	lastSyncedAt: Record<string, string>;

	/**
	 * Power-user escape hatch. When true, user-safety sanitation is
	 * bypassed on every GitHub body write (issues, PRs, releases, repo
	 * README, Dependabot advisory descriptions). Vault-integrity
	 * sanitation (wikilink `..` rewrite, persist-block marker escape)
	 * always runs regardless of this setting.
	 *
	 * Trades: Templater RCE, Dataview query injection, and raw HTML
	 * (script / iframe / event handlers / `javascript:` URLs) become
	 * possible from any synced GitHub body. Only enable on fully-
	 * controlled repos.
	 */
	disableBodySanitation: boolean;
}

export const DEFAULT_SETTINGS: GithubDataSettings = {
	schemaVersion: 1,
	token: "",
	useSecretStorage: false,
	secretTokenName: "github-data-pat",
	devVaultGitNoticeShown: false,
	repoAllowlist: [],
	syncCadenceMinutes: 15,
	activitySyncDays: 30,
	lastSyncedAt: {},
	disableBodySanitation: false,
};

/**
 * Merge loaded settings over defaults. Safe against partial data.
 *
 * Coercions are applied for fields where a malformed persisted value
 * could crash downstream logic -- e.g. `activitySyncDays` ends up as a
 * variable in a GraphQL query, so a `NaN` or a 10_000 would either
 * fail the query or (for oversize windows) violate GitHub's
 * contributionsCollection 1-year cap.
 */
export function mergeSettings(
	loaded: Partial<GithubDataSettings> | null | undefined,
): GithubDataSettings {
	return {
		...DEFAULT_SETTINGS,
		...(loaded ?? {}),
		// Ensure nested objects aren't shared references
		lastSyncedAt: { ...(loaded?.lastSyncedAt ?? {}) },
		repoAllowlist: [...(loaded?.repoAllowlist ?? [])],
		activitySyncDays: clampActivitySyncDays(loaded?.activitySyncDays),
		// Security-sensitive: coerce strictly so a persisted string
		// "false" or any other non-boolean payload can't silently
		// enable the user-safety bypass via a truthy check.
		disableBodySanitation: loaded?.disableBodySanitation === true,
	};
}

/**
 * Sanitize `activitySyncDays` from user-edited or corrupted settings
 * data. Valid range is 1..365 (GitHub's contributionsCollection caps
 * the query window at 1 year). Anything invalid falls back to the
 * default (30).
 */
function clampActivitySyncDays(raw: unknown): number {
	const n =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? Number.parseInt(raw, 10)
				: Number.NaN;
	if (!Number.isFinite(n)) return DEFAULT_SETTINGS.activitySyncDays;
	const floored = Math.floor(n);
	if (floored < 1) return DEFAULT_SETTINGS.activitySyncDays;
	if (floored > 365) return 365;
	return floored;
}
