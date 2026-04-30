import {
	BackgroundSyncScheduler,
	hasCadenceElapsed,
	pickDueCommands,
	SCHEDULER_INTERNALS_FOR_TESTS,
	type SchedulerHostContract,
	type SyncCommandId,
} from "./scheduler";

const { SYNC_COMMANDS, MIN_REMAINING_FOR_BACKGROUND } =
	SCHEDULER_INTERNALS_FOR_TESTS;

interface TestHostState {
	settings: SchedulerHostContract["settings"];
	token: string;
	rateLimitRemaining: number | null;
	calls: SyncCommandId[];
	failuresPerCommand: Partial<Record<SyncCommandId, number>>;
	throwOn?: SyncCommandId;
}

function makeHost(
	overrides: Partial<TestHostState> = {},
): { host: SchedulerHostContract; state: TestHostState } {
	const state: TestHostState = {
		settings: {
			backgroundSyncEnabled: true,
			syncCadenceMinutes: 15,
			token: "tok",
			repoAllowlist: ["a/b"],
			lastBackgroundRunAt: {},
		},
		token: "tok",
		rateLimitRemaining: 4000,
		calls: [],
		failuresPerCommand: {},
		...overrides,
	};

	const recordAndReturn = (id: SyncCommandId) => async () => {
		if (state.throwOn === id) throw new Error(`forced throw for ${id}`);
		state.calls.push(id);
		return { failed: state.failuresPerCommand[id] ?? 0 };
	};

	const host: SchedulerHostContract = {
		settings: state.settings,
		saveSettings: async () => {
			/* no-op */
		},
		getToken: () => state.token,
		rateLimitRemaining: () => state.rateLimitRemaining,
		syncAllRepoProfiles: recordAndReturn("repo-profiles"),
		syncAllOpenIssues: recordAndReturn("issues"),
		syncAllOpenPullRequests: recordAndReturn("prs"),
		syncAllReleases: recordAndReturn("releases"),
		syncAllDependabotAlerts: recordAndReturn("dependabot"),
		syncActivityFeed: recordAndReturn("activity"),
	};

	return { host, state };
}

describe("pickDueCommands", () => {
	test("tick 0 returns nothing", () => {
		expect(pickDueCommands(SYNC_COMMANDS, 0)).toEqual([]);
	});

	test("tick 1 fires only the HIGH tier (issues + PRs)", () => {
		const due = pickDueCommands(SYNC_COMMANDS, 1).map((c) => c.id);
		expect(due.sort()).toEqual(["issues", "prs"]);
	});

	test("tick 4 fires HIGH + MEDIUM (issues + PRs + activity)", () => {
		const due = pickDueCommands(SYNC_COMMANDS, 4).map((c) => c.id);
		expect(due.sort()).toEqual(["activity", "issues", "prs"]);
	});

	test("tick 24 fires all three tiers (HIGH + MEDIUM + LOW)", () => {
		const due = pickDueCommands(SYNC_COMMANDS, 24).map((c) => c.id);
		expect(due.sort()).toEqual([
			"activity",
			"dependabot",
			"issues",
			"prs",
			"releases",
			"repo-profiles",
		]);
	});

	test("tick 7 (a HIGH-only tick) does not fire MEDIUM or LOW", () => {
		const due = pickDueCommands(SYNC_COMMANDS, 7).map((c) => c.id);
		expect(due.sort()).toEqual(["issues", "prs"]);
	});

	test("tick 8 fires MEDIUM but not LOW (8 % 4 == 0, 8 % 24 != 0)", () => {
		const due = pickDueCommands(SYNC_COMMANDS, 8).map((c) => c.id);
		expect(due.sort()).toEqual(["activity", "issues", "prs"]);
	});
});

describe("hasCadenceElapsed", () => {
	const now = Date.parse("2026-04-30T12:00:00Z");

	test("returns true when no prior timestamp (fresh install)", () => {
		expect(hasCadenceElapsed(undefined, 60_000, now)).toBe(true);
	});

	test("returns true for an unparseable string", () => {
		expect(hasCadenceElapsed("not-a-date", 60_000, now)).toBe(true);
	});

	test("returns true when last run is older than the cadence", () => {
		const last = new Date(now - 90_000).toISOString();
		expect(hasCadenceElapsed(last, 60_000, now)).toBe(true);
	});

	test("returns false when last run is within the cadence", () => {
		const last = new Date(now - 30_000).toISOString();
		expect(hasCadenceElapsed(last, 60_000, now)).toBe(false);
	});

	test("returns true when last run is in the future (clock skew / cross-device sync)", () => {
		const last = new Date(now + 10_000).toISOString();
		expect(hasCadenceElapsed(last, 60_000, now)).toBe(true);
	});

	test("returns true at exactly the cadence boundary", () => {
		const last = new Date(now - 60_000).toISOString();
		expect(hasCadenceElapsed(last, 60_000, now)).toBe(true);
	});
});

describe("BackgroundSyncScheduler -- start/stop", () => {
	test("does not start when disabled", () => {
		const { host } = makeHost({
			settings: {
				backgroundSyncEnabled: false,
				syncCadenceMinutes: 15,
				token: "tok",
				repoAllowlist: ["a/b"],
				lastBackgroundRunAt: {},
			},
		});
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			setInterval: () => 99,
			clearInterval: () => undefined,
		});
		scheduler.start();
		expect(scheduler.isRunning()).toBe(false);
	});

	test("does not start without a token", () => {
		const { host } = makeHost({ token: "" });
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			setInterval: () => 99,
			clearInterval: () => undefined,
		});
		scheduler.start();
		expect(scheduler.isRunning()).toBe(false);
	});

	test("does not start with empty allowlist", () => {
		const { host } = makeHost({
			settings: {
				backgroundSyncEnabled: true,
				syncCadenceMinutes: 15,
				token: "tok",
				repoAllowlist: [],
				lastBackgroundRunAt: {},
			},
		});
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			setInterval: () => 99,
			clearInterval: () => undefined,
		});
		scheduler.start();
		expect(scheduler.isRunning()).toBe(false);
	});

	test("starts when enabled with token + allowlist", () => {
		const { host } = makeHost();
		let scheduledMs = 0;
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			setInterval: (_h, ms) => {
				scheduledMs = ms;
				return 42;
			},
			clearInterval: () => undefined,
		});
		scheduler.start();
		expect(scheduler.isRunning()).toBe(true);
		expect(scheduledMs).toBe(15 * 60_000);
	});

	test("start() is idempotent", () => {
		const { host } = makeHost();
		let setIntervalCalls = 0;
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			setInterval: () => {
				setIntervalCalls += 1;
				return 1;
			},
			clearInterval: () => undefined,
		});
		scheduler.start();
		scheduler.start();
		scheduler.start();
		expect(setIntervalCalls).toBe(1);
	});

	test("stop() clears the interval and isRunning() flips", () => {
		const { host } = makeHost();
		const cleared: number[] = [];
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			setInterval: () => 7,
			clearInterval: (id) => cleared.push(id),
		});
		scheduler.start();
		scheduler.stop();
		expect(scheduler.isRunning()).toBe(false);
		expect(cleared).toEqual([7]);
	});
});

describe("BackgroundSyncScheduler.tick", () => {
	test("first tick fires only the HIGH tier", async () => {
		const { host, state } = makeHost();
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
		});
		await scheduler.tick();
		expect(state.calls.sort()).toEqual(["issues", "prs"]);
	});

	test("tick 4 fires HIGH + MEDIUM (with cadence-elapsed gating)", async () => {
		const { host, state } = makeHost();
		// Advance the injected clock by 15 minutes between ticks so the
		// cadence-elapsed filter doesn't suppress HIGH-tier commands that
		// ran on the previous tick.
		let nowMs = Date.parse("2026-04-30T12:00:00Z");
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			now: () => nowMs,
		});
		await scheduler.tick(); // tick 1: issues + prs
		nowMs += 15 * 60_000;
		await scheduler.tick(); // tick 2: issues + prs
		nowMs += 15 * 60_000;
		await scheduler.tick(); // tick 3: issues + prs
		nowMs += 15 * 60_000;
		state.calls.length = 0;
		await scheduler.tick(); // tick 4: issues + prs + activity
		expect(state.calls.sort()).toEqual(["activity", "issues", "prs"]);
	});

	test("skips entire tick when rate-limit remaining is below threshold", async () => {
		const { host, state } = makeHost({
			rateLimitRemaining: MIN_REMAINING_FOR_BACKGROUND - 1,
		});
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
		});
		await scheduler.tick();
		expect(state.calls).toEqual([]);
	});

	test("does not skip when rate-limit snapshot is null (no calls made yet)", async () => {
		const { host, state } = makeHost({ rateLimitRemaining: null });
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
		});
		await scheduler.tick();
		expect(state.calls.length).toBeGreaterThan(0);
	});

	test("records lastBackgroundRunAt for each command that ran", async () => {
		const { host, state } = makeHost();
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			now: () => Date.parse("2026-04-30T12:00:00Z"),
		});
		await scheduler.tick();
		expect(state.settings.lastBackgroundRunAt.issues).toBe(
			"2026-04-30T12:00:00.000Z",
		);
		expect(state.settings.lastBackgroundRunAt.prs).toBe(
			"2026-04-30T12:00:00.000Z",
		);
		// Activity didn't run on tick 1
		expect(state.settings.lastBackgroundRunAt.activity).toBeUndefined();
	});

	test("a thrown command does not abort other commands in the same tick", async () => {
		const { host, state } = makeHost({ throwOn: "issues" });
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
		});
		await scheduler.tick();
		expect(state.calls).toEqual(["prs"]); // PRs still ran after issues threw
	});

	test("failures aggregate but don't stop subsequent commands", async () => {
		const { host, state } = makeHost({
			failuresPerCommand: { issues: 3, prs: 1 },
		});
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
		});
		await scheduler.tick();
		expect(state.calls.sort()).toEqual(["issues", "prs"]);
		// lastBackgroundRunAt is still recorded for failed commands -- the
		// run happened, the underlying writer just had per-repo failures
		expect(state.settings.lastBackgroundRunAt.issues).toBeDefined();
	});

	test("respects lastBackgroundRunAt -- a recently-run command is skipped", async () => {
		const fixedNow = Date.parse("2026-04-30T12:00:00Z");
		const { host, state } = makeHost();
		// Pretend issues ran 5 minutes ago; HIGH cadence at 15-min heartbeat
		// is 15 minutes -- 5 min < 15 min, so issues must be suppressed.
		state.settings.lastBackgroundRunAt.issues = new Date(
			fixedNow - 5 * 60_000,
		).toISOString();
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			now: () => fixedNow,
		});
		await scheduler.tick();
		expect(state.calls).toEqual(["prs"]);
	});

	test("a manual sync-equivalent timestamp older than cadence does not block the next tick", async () => {
		const fixedNow = Date.parse("2026-04-30T12:00:00Z");
		const { host, state } = makeHost();
		state.settings.lastBackgroundRunAt.issues = new Date(
			fixedNow - 16 * 60_000, // 16 min ago, > 15 min cadence
		).toISOString();
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
			now: () => fixedNow,
		});
		await scheduler.tick();
		expect(state.calls.sort()).toEqual(["issues", "prs"]);
	});

	test("single-flight guard drops overlapping ticks", async () => {
		const { host, state } = makeHost();
		// Make every command take a measurable amount of time so the
		// second tick fires while the first is still running.
		const slowCall = (id: SyncCommandId) => async () => {
			state.calls.push(id);
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			return { failed: 0 };
		};
		host.syncAllOpenIssues = slowCall("issues");
		host.syncAllOpenPullRequests = slowCall("prs");

		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
		});

		const first = scheduler.tick();
		const second = scheduler.tick(); // should drop on tickInFlight
		await Promise.all([first, second]);

		// Only one tick's worth of calls should have landed.
		expect(state.calls.sort()).toEqual(["issues", "prs"]);
	});

	test("saveSettings rejection is swallowed (does not throw out of tick)", async () => {
		const { host, state } = makeHost();
		host.saveSettings = async () => {
			throw new Error("disk full");
		};
		const scheduler = new BackgroundSyncScheduler(host, {
			registerInterval: (id) => id,
		});

		await expect(scheduler.tick()).resolves.toBeUndefined();
		// Calls still ran despite the persist failure.
		expect(state.calls.sort()).toEqual(["issues", "prs"]);
	});
});
