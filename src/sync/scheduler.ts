/**
 * Background sync scheduler.
 *
 * Opt-in heartbeat that fires sync commands on a cadence configured in
 * settings (`syncCadenceMinutes`, default 15). Each command belongs to
 * a frequency tier; on every tick, the scheduler runs the tier-eligible
 * commands whose minimum interval has elapsed since their last run.
 *
 * Tiers:
 * - **High** (every tick): issues, PRs. Most active surfaces -- review
 *   queue and incoming work need to feel live.
 * - **Medium** (every 4 ticks): activity. Per-day rollup; no value in
 *   refreshing every 15 minutes.
 * - **Low** (every 24 ticks): repo profiles, releases, Dependabot.
 *   Slow-moving; refreshing more often burns rate-limit budget for
 *   essentially no signal change.
 *
 * Defaults at the 15-minute heartbeat:
 * - Issues / PRs: every 15 min
 * - Activity:    every 1 hour
 * - Profiles / releases / Dependabot: every 6 hours
 *
 * Design constraints:
 *
 * 1. **Off by default.** The data-egress doc and README claim sync is
 *    user-initiated; flipping that posture without a deliberate user
 *    toggle would silently expand the plugin's network footprint. The
 *    `backgroundSyncEnabled` boolean is the master switch.
 *
 * 2. **Wait one interval before first fire.** Firing on plugin load
 *    competes with Obsidian startup work (other plugins, layout
 *    restoration, file index hydration). A first-fire delay of one
 *    cadence lets the editor settle before the scheduler starts.
 *
 * 3. **Silent on success, aggregate Notice on failure.** Six commands
 *    × N repos × every tick would be a Notice firehose. User-initiated
 *    syncs keep their per-command Notice; background runs aggregate
 *    failures into a single "N background syncs failed" Notice per
 *    tick (or stay silent if the tick was clean).
 *
 * 4. **Rate-limit gate.** Skip the entire tick when the most recent
 *    snapshot shows fewer than `MIN_REMAINING_FOR_BACKGROUND` requests
 *    left in the bucket. Avoids burning the last of the budget on
 *    background work that the user might need for an interactive run.
 *
 * 5. **Reuses plugin-lifetime state.** The sync commands already share
 *    `RateLimitTracker`, `CircuitBreaker`, and `Semaphore` via the
 *    plugin instance. Background runs flow through the same shared
 *    state, so concurrent manual + background runs never exceed the
 *    in-flight cap and an open circuit halts background work too.
 *
 * 6. **Failure tracking lands in `lastSyncError` automatically.** Each
 *    `syncAll*` method already calls `recordSyncOutcome` per repo;
 *    the Sync Progress view picks up background failures for free.
 */

import { Notice } from "obsidian";

const TIERS = {
	HIGH: 1,
	MEDIUM: 4,
	LOW: 24,
} as const;

/** Stable command ids -- match `lastBackgroundRunAt` keys in settings. */
export type SyncCommandId =
	| "issues"
	| "prs"
	| "activity"
	| "repo-profiles"
	| "releases"
	| "dependabot";

interface SyncCommand {
	id: SyncCommandId;
	tickEvery: number; // tier multiplier vs. base cadence
	label: string; // for failure-Notice copy
}

const SYNC_COMMANDS: readonly SyncCommand[] = [
	{ id: "issues", tickEvery: TIERS.HIGH, label: "issues" },
	{ id: "prs", tickEvery: TIERS.HIGH, label: "PRs" },
	{ id: "activity", tickEvery: TIERS.MEDIUM, label: "activity" },
	{ id: "repo-profiles", tickEvery: TIERS.LOW, label: "repo profiles" },
	{ id: "releases", tickEvery: TIERS.LOW, label: "releases" },
	{ id: "dependabot", tickEvery: TIERS.LOW, label: "Dependabot" },
] as const;

/**
 * Below this remaining-count we skip background ticks entirely. Picked
 * to leave headroom for: a typical interactive sync run (depends on
 * allowlist size and entity counts but ~50-200 calls is common) plus
 * Sync Progress view refreshes plus any other plugins sharing the same
 * PAT. 100 is a reasonable floor for a 5000/hr core bucket -- 2% of
 * budget reserved for the user's interactive needs.
 */
const MIN_REMAINING_FOR_BACKGROUND = 100;

/**
 * Subset of plugin surface the scheduler actually touches. Defined as
 * an interface so tests can substitute a fake without standing up the
 * full Obsidian Plugin lifecycle.
 */
export interface SchedulerHostContract {
	settings: {
		backgroundSyncEnabled: boolean;
		syncCadenceMinutes: number;
		token: string;
		repoAllowlist: string[];
		lastBackgroundRunAt: Record<string, string>;
	};
	saveSettings(): Promise<void>;
	getToken(): string;
	rateLimitRemaining(): number | null;

	syncAllRepoProfiles(options?: { silent?: boolean }): Promise<{ failed: number }>;
	syncAllOpenIssues(options?: { silent?: boolean }): Promise<{ failed: number }>;
	syncAllOpenPullRequests(
		options?: { silent?: boolean },
	): Promise<{ failed: number }>;
	syncAllReleases(options?: { silent?: boolean }): Promise<{ failed: number }>;
	syncAllDependabotAlerts(
		options?: { silent?: boolean },
	): Promise<{ failed: number }>;
	syncActivityFeed(options?: { silent?: boolean }): Promise<{ failed: number }>;
}

export interface BackgroundSyncSchedulerOptions {
	/**
	 * Hook into the plugin's `registerInterval` so the scheduler is
	 * cleaned up on plugin unload. Tests inject a no-op.
	 */
	registerInterval: (id: number) => number;
	/** Injected for tests. Defaults to `window.setInterval`. */
	setInterval?: (handler: () => void, ms: number) => number;
	/** Injected for tests. Defaults to `window.clearInterval`. */
	clearInterval?: (id: number) => void;
	/** Injected for tests. Defaults to `Date.now`. */
	now?: () => number;
}

export class BackgroundSyncScheduler {
	private intervalId: number | null = null;
	private tickCount = 0;
	private readonly setIntervalFn: (handler: () => void, ms: number) => number;
	private readonly clearIntervalFn: (id: number) => void;
	private readonly registerIntervalFn: (id: number) => number;
	private readonly now: () => number;

	constructor(
		private readonly host: SchedulerHostContract,
		options: BackgroundSyncSchedulerOptions,
	) {
		this.registerIntervalFn = options.registerInterval;
		this.setIntervalFn =
			options.setInterval ?? ((h, ms) => window.setInterval(h, ms));
		this.clearIntervalFn =
			options.clearInterval ?? ((id) => window.clearInterval(id));
		this.now = options.now ?? Date.now;
	}

	/** Start the heartbeat if enabled and a token is set. No-op if already running. */
	start(): void {
		if (this.intervalId !== null) return;
		if (!this.host.settings.backgroundSyncEnabled) return;
		if (!this.host.getToken()) return;
		if (this.host.settings.repoAllowlist.length === 0) return;

		const cadenceMs = this.host.settings.syncCadenceMinutes * 60_000;
		this.tickCount = 0;
		this.intervalId = this.setIntervalFn(() => {
			void this.tick();
		}, cadenceMs);
		this.registerIntervalFn(this.intervalId);
	}

	stop(): void {
		if (this.intervalId === null) return;
		this.clearIntervalFn(this.intervalId);
		this.intervalId = null;
	}

	/** Stop and start. Use after the user changes the toggle or cadence. */
	restart(): void {
		this.stop();
		this.start();
	}

	isRunning(): boolean {
		return this.intervalId !== null;
	}

	/**
	 * One heartbeat tick. Public for tests; in production it's the
	 * setInterval callback. Always returns rather than throwing so a
	 * single bad tick doesn't kill the scheduler.
	 */
	async tick(): Promise<void> {
		this.tickCount += 1;

		const remaining = this.host.rateLimitRemaining();
		if (
			typeof remaining === "number" &&
			remaining < MIN_REMAINING_FOR_BACKGROUND
		) {
			console.warn(
				`[github-data] background sync skipping tick: rate-limit remaining=${remaining} below threshold ${MIN_REMAINING_FOR_BACKGROUND}`,
			);
			return;
		}

		const due = pickDueCommands(SYNC_COMMANDS, this.tickCount);

		let totalFailed = 0;
		const failedLabels: string[] = [];
		for (const cmd of due) {
			try {
				const result = await this.runCommand(cmd);
				if (result.failed > 0) {
					totalFailed += result.failed;
					failedLabels.push(cmd.label);
				}
				this.host.settings.lastBackgroundRunAt[cmd.id] = new Date(
					this.now(),
				).toISOString();
			} catch (err) {
				totalFailed += 1;
				failedLabels.push(cmd.label);
				console.warn(
					`[github-data] background sync ${cmd.id} threw:`,
					err,
				);
			}
		}

		if (due.length > 0) {
			await this.host.saveSettings();
		}

		if (totalFailed > 0) {
			new Notice(
				`GitHub Data: background sync had ${totalFailed} failure(s) (${failedLabels.join(", ")}). Open Sync Progress for details.`,
				8000,
			);
		}
	}

	private async runCommand(cmd: SyncCommand): Promise<{ failed: number }> {
		switch (cmd.id) {
			case "issues":
				return this.host.syncAllOpenIssues({ silent: true });
			case "prs":
				return this.host.syncAllOpenPullRequests({ silent: true });
			case "activity":
				return this.host.syncActivityFeed({ silent: true });
			case "repo-profiles":
				return this.host.syncAllRepoProfiles({ silent: true });
			case "releases":
				return this.host.syncAllReleases({ silent: true });
			case "dependabot":
				return this.host.syncAllDependabotAlerts({ silent: true });
		}
	}
}

/**
 * Pure decision: which commands are due to fire on a given tick number.
 * A command is due when `tickCount` is divisible by its `tickEvery`
 * tier multiplier. Tick 1 fires HIGH only; tick 4 fires HIGH + MEDIUM;
 * tick 24 fires all three tiers.
 *
 * Exposed for tests; the scheduler instance calls it internally.
 */
export function pickDueCommands(
	commands: readonly SyncCommand[],
	tickCount: number,
): SyncCommand[] {
	if (tickCount <= 0) return [];
	return commands.filter((c) => tickCount % c.tickEvery === 0);
}

export const SCHEDULER_INTERNALS_FOR_TESTS = {
	SYNC_COMMANDS,
	TIERS,
	MIN_REMAINING_FOR_BACKGROUND,
};
