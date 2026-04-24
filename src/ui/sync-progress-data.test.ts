import { DEFAULT_SETTINGS } from "../settings/types";
import {
	REPOS_ROOT,
	buildRepoStatusRows,
	formatRelativeTime,
} from "./sync-progress-data";

function files(paths: string[]) {
	return paths.map((path) => ({ path }));
}

describe("buildRepoStatusRows", () => {
	test("empty allowlist -> no rows", () => {
		expect(buildRepoStatusRows(DEFAULT_SETTINGS, [])).toEqual([]);
	});

	test("counts issues / PRs / releases / dependabot under the repo folder", () => {
		const rows = buildRepoStatusRows(
			{
				...DEFAULT_SETTINGS,
				repoAllowlist: ["bit-incarnas/eden"],
			},
			files([
				`${REPOS_ROOT}/bit-incarnas__eden/00_eden.md`,
				`${REPOS_ROOT}/bit-incarnas__eden/Issues/1-hello.md`,
				`${REPOS_ROOT}/bit-incarnas__eden/Issues/2-world.md`,
				`${REPOS_ROOT}/bit-incarnas__eden/Pull_Requests/3-pr.md`,
				`${REPOS_ROOT}/bit-incarnas__eden/Releases/v1.0.md`,
				`${REPOS_ROOT}/bit-incarnas__eden/Dependabot/4-lodash-high.md`,
				`${REPOS_ROOT}/bit-incarnas__eden/Dependabot/5-axios-medium.md`,
			]),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].counts).toEqual({
			issues: 2,
			prs: 1,
			releases: 1,
			dependabot: 2,
		});
	});

	test("ignores files under unrelated repos / outside the root", () => {
		const rows = buildRepoStatusRows(
			{
				...DEFAULT_SETTINGS,
				repoAllowlist: ["bit-incarnas/eden"],
			},
			files([
				`${REPOS_ROOT}/other-owner__other-repo/Issues/99-x.md`,
				"00_HUD/17_GitHub_Console.md",
				`${REPOS_ROOT}/bit-incarnas__eden/Issues/1-ok.md`,
			]),
		);
		expect(rows[0].counts.issues).toBe(1);
	});

	test("case-insensitive folder matching (GitHub repos lowercase-canon)", () => {
		const rows = buildRepoStatusRows(
			{
				...DEFAULT_SETTINGS,
				repoAllowlist: ["Bit-Incarnas/Eden"],
			},
			files([
				`${REPOS_ROOT}/bit-incarnas__eden/Issues/1-x.md`,
				`${REPOS_ROOT}/BIT-INCARNAS__EDEN/Issues/2-y.md`,
			]),
		);
		expect(rows[0].counts.issues).toBe(2);
		expect(rows[0].repoKey).toBe("bit-incarnas/eden");
	});

	test("surfaces lastSyncedAt + lastError from settings", () => {
		const rows = buildRepoStatusRows(
			{
				...DEFAULT_SETTINGS,
				repoAllowlist: ["a/b", "c/d"],
				lastSyncedAt: { "a/b": "2026-04-23T01:02:03Z" },
				lastSyncError: {
					"c/d": {
						at: "2026-04-23T04:05:06Z",
						message: "401",
						kind: "http-4xx",
					},
				},
			},
			[],
		);
		expect(rows[0].lastSyncedAt).toBe("2026-04-23T01:02:03Z");
		expect(rows[0].lastError).toBeNull();
		expect(rows[1].lastSyncedAt).toBeNull();
		expect(rows[1].lastError?.kind).toBe("http-4xx");
	});

	test("allowlist entries missing '/' are dropped", () => {
		const rows = buildRepoStatusRows(
			{
				...DEFAULT_SETTINGS,
				repoAllowlist: ["invalid", "good/repo", ""],
			},
			[],
		);
		expect(rows.map((r) => r.repo)).toEqual(["good/repo"]);
	});

	test("trailing / leading whitespace trimmed", () => {
		const rows = buildRepoStatusRows(
			{
				...DEFAULT_SETTINGS,
				repoAllowlist: ["  a/b  "],
			},
			[],
		);
		expect(rows[0].repo).toBe("a/b");
		expect(rows[0].repoKey).toBe("a/b");
	});

	test("does NOT count the 00_{repo}.md profile file as an entity", () => {
		const rows = buildRepoStatusRows(
			{
				...DEFAULT_SETTINGS,
				repoAllowlist: ["a/b"],
			},
			files([`${REPOS_ROOT}/a__b/00_b.md`]),
		);
		expect(rows[0].counts).toEqual({
			issues: 0,
			prs: 0,
			releases: 0,
			dependabot: 0,
		});
	});
});

describe("formatRelativeTime", () => {
	const now = new Date("2026-04-23T12:00:00Z");

	test("null -> 'never'", () => {
		expect(formatRelativeTime(null, now)).toBe("never");
	});

	test("malformed -> 'never'", () => {
		expect(formatRelativeTime("not-a-date", now)).toBe("never");
	});

	test("future timestamp -> 'just now'", () => {
		expect(formatRelativeTime("2026-04-23T12:01:00Z", now)).toBe(
			"just now",
		);
	});

	test("seconds / minutes / hours / days / months / years units", () => {
		expect(formatRelativeTime("2026-04-23T11:59:30Z", now)).toBe("30s ago");
		expect(formatRelativeTime("2026-04-23T11:30:00Z", now)).toBe("30m ago");
		expect(formatRelativeTime("2026-04-23T06:00:00Z", now)).toBe("6h ago");
		expect(formatRelativeTime("2026-04-20T12:00:00Z", now)).toBe("3d ago");
		expect(formatRelativeTime("2026-02-23T12:00:00Z", now)).toBe("1mo ago");
		expect(formatRelativeTime("2024-04-23T12:00:00Z", now)).toBe("2y ago");
	});
});
