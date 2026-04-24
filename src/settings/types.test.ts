import { DEFAULT_SETTINGS, mergeSettings } from "./types";

describe("mergeSettings", () => {
	test("returns defaults for null / undefined / empty", () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	test("preserves valid fields from loaded payload", () => {
		const result = mergeSettings({
			repoAllowlist: ["a/b", "c/d"],
			token: "ghp_abc",
			useSecretStorage: true,
		});
		expect(result.repoAllowlist).toEqual(["a/b", "c/d"]);
		expect(result.token).toBe("ghp_abc");
		expect(result.useSecretStorage).toBe(true);
	});

	test("defensively copies nested collections", () => {
		const list = ["x/y"];
		const map = { "x/y": "2026-04-23T00:00:00Z" };
		const result = mergeSettings({
			repoAllowlist: list,
			lastSyncedAt: map,
		});
		expect(result.repoAllowlist).not.toBe(list);
		expect(result.lastSyncedAt).not.toBe(map);
		expect(result.repoAllowlist).toEqual(list);
		expect(result.lastSyncedAt).toEqual(map);
	});

	describe("disableBodySanitation strict coercion", () => {
		test("true stays true", () => {
			const r = mergeSettings({ disableBodySanitation: true });
			expect(r.disableBodySanitation).toBe(true);
		});

		test("default is false", () => {
			expect(mergeSettings({}).disableBodySanitation).toBe(false);
			expect(DEFAULT_SETTINGS.disableBodySanitation).toBe(false);
		});

		test("missing / null / undefined coerce to false", () => {
			expect(mergeSettings(null).disableBodySanitation).toBe(false);
			expect(mergeSettings(undefined).disableBodySanitation).toBe(false);
			expect(
				mergeSettings({ disableBodySanitation: undefined })
					.disableBodySanitation,
			).toBe(false);
		});

		test("stringified 'true' coerces to false (strict equality required)", () => {
			// Security-sensitive: a truthy string must NOT enable the bypass.
			// Hand-edited data.json or a botched migration could produce this.
			const r = mergeSettings({
				disableBodySanitation: "true" as unknown as boolean,
			});
			expect(r.disableBodySanitation).toBe(false);
		});

		test("stringified 'false' coerces to false (not truthy)", () => {
			// The original bug motivating strict coercion: `"false"` is a
			// non-empty string and therefore truthy under `if (x)`.
			const r = mergeSettings({
				disableBodySanitation: "false" as unknown as boolean,
			});
			expect(r.disableBodySanitation).toBe(false);
		});

		test("numeric 1 coerces to false", () => {
			const r = mergeSettings({
				disableBodySanitation: 1 as unknown as boolean,
			});
			expect(r.disableBodySanitation).toBe(false);
		});

		test("non-empty object coerces to false", () => {
			const r = mergeSettings({
				disableBodySanitation: {
					enabled: true,
				} as unknown as boolean,
			});
			expect(r.disableBodySanitation).toBe(false);
		});

		test("explicit false stays false", () => {
			const r = mergeSettings({ disableBodySanitation: false });
			expect(r.disableBodySanitation).toBe(false);
		});
	});

	describe("lastSyncError normalization", () => {
		test("default is empty map", () => {
			expect(mergeSettings({}).lastSyncError).toEqual({});
			expect(DEFAULT_SETTINGS.lastSyncError).toEqual({});
		});

		test("copy is defensive (not same reference)", () => {
			const map = {
				"a/b": {
					at: "2026-04-23T00:00:00Z",
					message: "network",
					kind: "network" as const,
				},
			};
			const result = mergeSettings({ lastSyncError: map });
			expect(result.lastSyncError).toEqual(map);
			expect(result.lastSyncError).not.toBe(map);
		});

		test("non-object payload coerces to empty map", () => {
			expect(
				mergeSettings({
					lastSyncError: "hostile" as unknown as Record<
						string,
						never
					>,
				}).lastSyncError,
			).toEqual({});
			expect(
				mergeSettings({
					lastSyncError: [1, 2, 3] as unknown as Record<
						string,
						never
					>,
				}).lastSyncError,
			).toEqual({});
		});

		test("entries missing required fields are dropped", () => {
			const result = mergeSettings({
				lastSyncError: {
					"good/repo": {
						at: "2026-04-23T00:00:00Z",
						message: "ok",
						kind: "http-4xx",
					},
					"bad/repo": { message: "no at" } as unknown as never,
					"also/bad": "not-an-object" as unknown as never,
				},
			});
			expect(Object.keys(result.lastSyncError)).toEqual(["good/repo"]);
		});

		test("unknown kind coerces to 'unknown'", () => {
			const result = mergeSettings({
				lastSyncError: {
					"a/b": {
						at: "2026-04-23T00:00:00Z",
						message: "weird",
						kind: "fabricated" as unknown as "unknown",
					},
				},
			});
			expect(result.lastSyncError["a/b"].kind).toBe("unknown");
		});
	});

	describe("activitySyncDays clamp (regression guard)", () => {
		test("valid value preserved", () => {
			expect(mergeSettings({ activitySyncDays: 90 }).activitySyncDays).toBe(
				90,
			);
		});

		test("out-of-range high is clamped", () => {
			expect(
				mergeSettings({ activitySyncDays: 10000 }).activitySyncDays,
			).toBe(365);
		});

		test("zero / negative fall back to default", () => {
			expect(
				mergeSettings({ activitySyncDays: 0 }).activitySyncDays,
			).toBe(DEFAULT_SETTINGS.activitySyncDays);
			expect(
				mergeSettings({ activitySyncDays: -5 }).activitySyncDays,
			).toBe(DEFAULT_SETTINGS.activitySyncDays);
		});

		test("non-finite falls back to default", () => {
			expect(
				mergeSettings({
					activitySyncDays: Number.NaN as unknown as number,
				}).activitySyncDays,
			).toBe(DEFAULT_SETTINGS.activitySyncDays);
		});
	});
});
