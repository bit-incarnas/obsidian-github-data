import {
	processCodeblock,
	scanEntityRecords,
	type ProcessorDeps,
} from "./processor";
import type { App, TFile } from "obsidian";
import type { GithubDataSettings } from "../settings/types";

function makeSettings(
	allowlist: string[] = ["bit-incarnas/eden"],
): GithubDataSettings {
	return {
		schemaVersion: 1,
		token: "",
		useSecretStorage: false,
		secretTokenName: "github-data-pat",
		devVaultGitNoticeShown: false,
		repoAllowlist: allowlist,
		syncCadenceMinutes: 0,
		activitySyncDays: 30,
		lastSyncedAt: {},
		disableBodySanitation: false,
	};
}

function makeApp(
	files: Array<{ path: string; frontmatter: Record<string, unknown> | null }>,
): App {
	const mdFiles = files.map((f) => ({ path: f.path }) as TFile);
	const cacheByPath = new Map(
		files.map((f) => [
			f.path,
			f.frontmatter
				? { frontmatter: { position: { start: 0, end: 0 }, ...f.frontmatter } }
				: null,
		]),
	);
	return {
		vault: {
			getMarkdownFiles: () => mdFiles,
		},
		metadataCache: {
			getFileCache: (file: TFile) => cacheByPath.get(file.path) ?? null,
		},
	} as unknown as App;
}

describe("scanEntityRecords", () => {
	test("returns frontmatter for files under vaultRoot", () => {
		const app = makeApp([
			{
				path: "02_AREAS/GitHub/Repos/x__y/Issues/1.md",
				frontmatter: { type: "github_issue", number: 1 },
			},
			{
				path: "02_AREAS/GitHub/Repos/x__y/Pull_Requests/2.md",
				frontmatter: { type: "github_pr", number: 2 },
			},
			{
				path: "00_HUD/17_GitHub_Console.md",
				frontmatter: { type: "other" },
			},
		]);
		const out = scanEntityRecords(app, "02_AREAS/GitHub/Repos");
		expect(out).toHaveLength(2);
		expect(out.map((r) => r.path).sort()).toEqual([
			"02_AREAS/GitHub/Repos/x__y/Issues/1.md",
			"02_AREAS/GitHub/Repos/x__y/Pull_Requests/2.md",
		]);
	});

	test("skips files without frontmatter", () => {
		const app = makeApp([
			{
				path: "02_AREAS/GitHub/Repos/x__y/README.md",
				frontmatter: null,
			},
		]);
		expect(scanEntityRecords(app, "02_AREAS/GitHub/Repos")).toEqual([]);
	});

	test("strips Obsidian's internal `position` key from returned frontmatter", () => {
		const app = makeApp([
			{
				path: "02_AREAS/GitHub/Repos/x__y/Issues/1.md",
				frontmatter: { type: "github_issue", number: 1 },
			},
		]);
		const [rec] = scanEntityRecords(app, "02_AREAS/GitHub/Repos");
		expect(rec.frontmatter).not.toHaveProperty("position");
		expect(rec.frontmatter.type).toBe("github_issue");
	});

	test("directory-boundary check rejects sibling prefixes", () => {
		// Classic startsWith bug: "02_AREAS/GitHub" would naively match
		// "02_AREAS/GitHub_Other_Folder/anything.md". The isInsideRoot
		// check requires a trailing `/` after the root.
		const app = makeApp([
			{
				path: "02_AREAS/GitHub/Repos/x__y/Issues/1.md",
				frontmatter: { type: "github_issue", number: 1 },
			},
			{
				path: "02_AREAS/GitHub_Other_Folder/foo.md",
				frontmatter: { type: "github_issue", number: 99 },
			},
			{
				path: "02_AREAS/GitHub_Notes/bar.md",
				frontmatter: { type: "github_issue", number: 100 },
			},
		]);
		const out = scanEntityRecords(app, "02_AREAS/GitHub/Repos");
		expect(out).toHaveLength(1);
		expect(out[0].path).toBe("02_AREAS/GitHub/Repos/x__y/Issues/1.md");
	});

	test("accepts trailing-slash form of vaultRoot equivalently", () => {
		const app = makeApp([
			{
				path: "02_AREAS/GitHub/Repos/x__y/Issues/1.md",
				frontmatter: { type: "github_issue", number: 1 },
			},
		]);
		expect(
			scanEntityRecords(app, "02_AREAS/GitHub/Repos/"),
		).toHaveLength(1);
		expect(
			scanEntityRecords(app, "02_AREAS/GitHub/Repos"),
		).toHaveLength(1);
	});
});

describe("processCodeblock -- errors", () => {
	function setup(allowlist?: string[]): {
		deps: ProcessorDeps;
		el: HTMLElement;
	} {
		const app = makeApp([]);
		const deps: ProcessorDeps = {
			app,
			getSettings: () => makeSettings(allowlist),
		};
		return { deps, el: document.createElement("div") };
	}

	test("renders error tile on bad YAML body", () => {
		const { deps, el } = setup();
		// numeric top-level, not an object
		processCodeblock("42", el, "github-issue", deps);
		expect(el.querySelector(".github-data-codeblock-error")).not.toBeNull();
	});

	test("renders error tile on unknown field", () => {
		const { deps, el } = setup();
		processCodeblock('{"mystery": "x"}', el, "github-issue", deps);
		const warn = el.querySelector(".github-data-codeblock-error");
		expect(warn).not.toBeNull();
		expect(warn!.textContent).toMatch(/Unknown field/);
	});

	test("refuses repo not in allowlist", () => {
		const { deps, el } = setup(["other/owner"]);
		processCodeblock(
			'{"repo": "bit-incarnas/eden"}',
			el,
			"github-issue",
			deps,
		);
		const warn = el.querySelector(".github-data-codeblock-error");
		expect(warn).not.toBeNull();
		expect(warn!.textContent).toMatch(/not in the allowlist/);
	});

	test("allows repo in allowlist (case-insensitive)", () => {
		const app = makeApp([]);
		const deps: ProcessorDeps = {
			app,
			getSettings: () => makeSettings(["bit-incarnas/eden"]),
		};
		const el = document.createElement("div");
		// Different casing than stored allowlist entry should still resolve.
		processCodeblock(
			'{"repo": "Bit-Incarnas/EDEN"}',
			el,
			"github-issue",
			deps,
		);
		expect(el.querySelector(".github-data-codeblock-error")).toBeNull();
		// Empty result -> empty-state div
		expect(el.querySelector(".github-data-empty")).not.toBeNull();
	});
});

describe("processCodeblock -- happy path", () => {
	test("end-to-end: scans vault, filters, renders table", () => {
		const app = makeApp([
			{
				path: "02_AREAS/GitHub/Repos/x__y/Issues/1-a.md",
				frontmatter: {
					type: "github_issue",
					repo: "x/y",
					state: "open",
					number: 1,
					title: "Issue A",
					updated: "2026-04-20T10:00:00Z",
					labels: ["bug"],
					author: "me",
				},
			},
			{
				path: "02_AREAS/GitHub/Repos/x__y/Issues/2-b.md",
				frontmatter: {
					type: "github_issue",
					repo: "x/y",
					state: "closed",
					number: 2,
					title: "Issue B",
					updated: "2026-04-21T10:00:00Z",
					labels: [],
					author: "me",
				},
			},
		]);
		const deps: ProcessorDeps = {
			app,
			getSettings: () => makeSettings(["x/y"]),
		};
		const el = document.createElement("div");

		processCodeblock(
			'{"repo": "x/y", "state": "open"}',
			el,
			"github-issue",
			deps,
		);

		const rows = el.querySelectorAll("tbody tr");
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain("Issue A");
	});

	test("empty-state when no matches", () => {
		const app = makeApp([]);
		const deps: ProcessorDeps = {
			app,
			getSettings: () => makeSettings(),
		};
		const el = document.createElement("div");
		processCodeblock("", el, "github-issue", deps);
		expect(el.querySelector(".github-data-empty")).not.toBeNull();
	});

	test("omitted repo: arg -- records from non-allowlisted repos are dropped", () => {
		// Simulate a vault that has synced files for two repos, where
		// only one is currently allowlisted (the other was removed from
		// the allowlist after its last sync).
		const app = makeApp([
			{
				path: "02_AREAS/GitHub/Repos/x__y/Issues/1-a.md",
				frontmatter: {
					type: "github_issue",
					repo: "x/y",
					state: "open",
					number: 1,
					title: "Kept issue",
				},
			},
			{
				path: "02_AREAS/GitHub/Repos/z__stale/Issues/2-b.md",
				frontmatter: {
					type: "github_issue",
					repo: "z/stale",
					state: "open",
					number: 2,
					title: "Stale issue",
				},
			},
		]);
		const deps: ProcessorDeps = {
			app,
			getSettings: () => makeSettings(["x/y"]),
		};
		const el = document.createElement("div");

		// No repo: arg -> "all my repos". Stale record should be filtered out.
		processCodeblock("", el, "github-issue", deps);

		const rows = el.querySelectorAll("tbody tr");
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain("Kept issue");
		expect(rows[0].textContent).not.toContain("Stale issue");
	});

	test("unexpected throw in pipeline renders error tile (doesn't break note)", () => {
		const el = document.createElement("div");
		const crashingApp = {
			vault: {
				getMarkdownFiles: () => {
					throw new Error("simulated metadataCache crash");
				},
			},
			metadataCache: { getFileCache: () => null },
		} as unknown as import("obsidian").App;
		const deps: ProcessorDeps = {
			app: crashingApp,
			getSettings: () => makeSettings(),
		};

		// Should NOT throw; should render an error tile with the message.
		expect(() =>
			processCodeblock("", el, "github-issue", deps),
		).not.toThrow();
		const warn = el.querySelector(".github-data-codeblock-error");
		expect(warn).not.toBeNull();
		expect(warn!.textContent).toMatch(/simulated metadataCache crash/);
	});
});
