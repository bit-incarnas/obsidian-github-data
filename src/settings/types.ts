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

	/**
	 * Background sync master switch. Default false -- background sync is
	 * opt-in. The README and docs/data-egress.md both describe sync as
	 * user-initiated; flipping this requires a deliberate settings change.
	 */
	backgroundSyncEnabled: boolean;

	/**
	 * Heartbeat cadence (minutes) for background sync. Each tick fires the
	 * frequency tiers that are due (issues / PRs every tick; activity every
	 * 4 ticks; releases / profiles / Dependabot every 24 ticks). 1-1440.
	 */
	syncCadenceMinutes: number;

	/**
	 * Last time each background-sync command was run (ISO-8601 UTC). Keyed
	 * by the same ids the scheduler iterates: `repo-profiles`, `issues`,
	 * `prs`, `releases`, `dependabot`, `activity`. Drives the "skip if
	 * recently run" guard so a manual sync between ticks pushes the next
	 * scheduled fire of that command out by its tier cadence.
	 */
	lastBackgroundRunAt: Record<string, string>;

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

	/**
	 * Last sync failure per repo (`owner/repo` -> record). Populated by
	 * the sync engine; cleared on next successful sync for that repo.
	 * Used by the Sync Progress view to surface failures at a glance
	 * without parsing logs.
	 */
	lastSyncError: Record<string, SyncErrorRecord>;
}

export interface SyncErrorRecord {
	/** ISO-8601 UTC timestamp when the failure was recorded. */
	at: string;
	/** Short human-readable reason (already sanitized by the sync loop). */
	message: string;
	/** Rough kind bucket the view can badge. */
	kind: SyncErrorKind;
}

export type SyncErrorKind =
	| "network"
	| "http-4xx"
	| "http-5xx"
	| "circuit-open"
	| "unknown";

export const DEFAULT_SETTINGS: GithubDataSettings = {
	schemaVersion: 2,
	token: "",
	useSecretStorage: false,
	secretTokenName: "github-data-pat",
	devVaultGitNoticeShown: false,
	repoAllowlist: [],
	backgroundSyncEnabled: false,
	syncCadenceMinutes: 15,
	activitySyncDays: 30,
	lastSyncedAt: {},
	disableBodySanitation: false,
	lastSyncError: {},
	lastBackgroundRunAt: {},
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
		syncCadenceMinutes: clampSyncCadenceMinutes(loaded?.syncCadenceMinutes),
		// Strict-boolean coercion: a corrupted or hand-edited "true"
		// string mustn't silently flip background sync on. Same rule as
		// disableBodySanitation: only the literal `true` enables it.
		backgroundSyncEnabled: loaded?.backgroundSyncEnabled === true,
		// Security-sensitive: coerce strictly so a persisted string
		// "false" or any other non-boolean payload can't silently
		// enable the user-safety bypass via a truthy check.
		disableBodySanitation: loaded?.disableBodySanitation === true,
		// Defensive copy so view-rendering code can't mutate persisted
		// state; guards against corrupted payloads (non-object) too.
		lastSyncError: normalizeSyncErrorMap(loaded?.lastSyncError),
		lastBackgroundRunAt: normalizeStringMap(loaded?.lastBackgroundRunAt),
	};
}

function normalizeStringMap(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

const SYNC_ERROR_KINDS: ReadonlySet<SyncErrorKind> = new Set([
	"network",
	"http-4xx",
	"http-5xx",
	"circuit-open",
	"unknown",
]);

function normalizeSyncErrorMap(
	raw: unknown,
): Record<string, SyncErrorRecord> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, SyncErrorRecord> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const v = value as Partial<SyncErrorRecord>;
		if (typeof v.at !== "string" || typeof v.message !== "string") continue;
		const kind: SyncErrorKind =
			typeof v.kind === "string" &&
			SYNC_ERROR_KINDS.has(v.kind as SyncErrorKind)
				? (v.kind as SyncErrorKind)
				: "unknown";
		out[key] = { at: v.at, message: v.message, kind };
	}
	return out;
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

/**
 * Sanitize `syncCadenceMinutes`. 1 minute floor (anything faster is a
 * footgun against GitHub's secondary rate limits); 1440 (24h) ceiling
 * since longer cadences are functionally "off." Out-of-range or
 * non-numeric values fall back to the default (15).
 */
function clampSyncCadenceMinutes(raw: unknown): number {
	const n =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? Number.parseInt(raw, 10)
				: Number.NaN;
	if (!Number.isFinite(n)) return DEFAULT_SETTINGS.syncCadenceMinutes;
	const floored = Math.floor(n);
	if (floored < 1) return DEFAULT_SETTINGS.syncCadenceMinutes;
	if (floored > 1440) return 1440;
	return floored;
}
