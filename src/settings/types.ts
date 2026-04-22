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

	/** Last successful sync per repo (ISO-8601 UTC). Populated by the sync engine. */
	lastSyncedAt: Record<string, string>;
}

export const DEFAULT_SETTINGS: GithubDataSettings = {
	schemaVersion: 1,
	token: "",
	useSecretStorage: false,
	secretTokenName: "github-data-pat",
	devVaultGitNoticeShown: false,
	repoAllowlist: [],
	syncCadenceMinutes: 15,
	lastSyncedAt: {},
};

/**
 * Merge loaded settings over defaults. Safe against partial data.
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
	};
}
