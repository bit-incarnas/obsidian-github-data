import { WorkspaceLeaf } from "obsidian";
import type { CircuitBreaker } from "../github/circuit-breaker";
import type { RateLimitTracker } from "../github/rate-limit";
import { DEFAULT_SETTINGS, type GithubDataSettings } from "../settings/types";
import {
	SyncProgressView,
	type SyncProgressViewPlugin,
} from "./sync-progress-view";

function makePlugin(
	overrides: Partial<SyncProgressViewPlugin> = {},
): SyncProgressViewPlugin {
	const files: Array<{ path: string }> = [];
	const defaultCircuit = {
		isOpen: () => false,
		getReason: () => null,
	} as Pick<CircuitBreaker, "isOpen" | "getReason">;
	const defaultRateLimit = {
		getSnapshot: () => null,
	} as Pick<RateLimitTracker, "getSnapshot">;
	return {
		app: {
			vault: {
				getMarkdownFiles: () => files,
			},
		},
		settings: { ...DEFAULT_SETTINGS },
		circuit: defaultCircuit,
		rateLimit: defaultRateLimit,
		resetCircuit: jest.fn(async () => {}),
		...overrides,
	};
}

function makeLeaf(app: unknown): WorkspaceLeaf {
	const leaf = new WorkspaceLeaf();
	(leaf as unknown as { app: unknown }).app = app;
	return leaf;
}

function mountView(
	plugin: SyncProgressViewPlugin,
): { view: SyncProgressView; root: HTMLElement } {
	const leaf = makeLeaf(plugin.app);
	const view = new SyncProgressView(leaf, plugin);
	// Kick onOpen so the initial render fires.
	void view.onOpen();
	return { view, root: view.contentEl };
}

describe("SyncProgressView", () => {
	test("empty allowlist -> renders empty-state message", () => {
		const plugin = makePlugin();
		const { root } = mountView(plugin);
		expect(root.textContent ?? "").toMatch(
			/No repositories allowlisted/i,
		);
	});

	test("renders one row per allowlist entry with entity counts", () => {
		const plugin = makePlugin({
			settings: {
				...DEFAULT_SETTINGS,
				repoAllowlist: ["bit-incarnas/eden"],
			},
			app: {
				vault: {
					getMarkdownFiles: () => [
						{ path: "02_AREAS/GitHub/Repos/bit-incarnas__eden/Issues/1.md" },
						{ path: "02_AREAS/GitHub/Repos/bit-incarnas__eden/Issues/2.md" },
						{ path: "02_AREAS/GitHub/Repos/bit-incarnas__eden/Pull_Requests/3.md" },
					],
				},
			},
		});
		const { root } = mountView(plugin);
		const rows = root.querySelectorAll("tbody tr");
		expect(rows.length).toBe(1);
		const cells = rows[0].querySelectorAll("td");
		expect(cells[0].textContent).toBe("bit-incarnas/eden");
		// Cells are: repo, last synced, issues, prs, releases, dependabot, status
		expect(cells[2].textContent).toBe("2"); // issues
		expect(cells[3].textContent).toBe("1"); // prs
		expect(cells[4].textContent).toBe("0"); // releases
		expect(cells[5].textContent).toBe("0"); // dependabot
	});

	test("renders the sanitation-disabled banner when the toggle is on", () => {
		const plugin = makePlugin({
			settings: { ...DEFAULT_SETTINGS, disableBodySanitation: true },
		});
		const { root } = mountView(plugin);
		expect(root.textContent ?? "").toMatch(
			/Body sanitation is DISABLED/i,
		);
	});

	test("no sanitation banner when toggle is off (default)", () => {
		const { root } = mountView(makePlugin());
		expect(root.textContent ?? "").not.toMatch(/sanitation is DISABLED/i);
	});

	test("renders the circuit-open banner + reset button when tripped", () => {
		const resetCircuit = jest.fn(async () => {});
		const plugin = makePlugin({
			circuit: {
				isOpen: () => true,
				getReason: () => "401 twice",
			},
			resetCircuit,
		});
		const { root } = mountView(plugin);
		expect(root.textContent ?? "").toMatch(/Auth circuit OPEN: 401 twice/);
		const resetBtn = Array.from(root.querySelectorAll("button")).find(
			(b) => b.textContent === "Reset circuit",
		);
		expect(resetBtn).toBeDefined();
	});

	test("surfaces lastSyncError per repo in the Status column", () => {
		const settings: GithubDataSettings = {
			...DEFAULT_SETTINGS,
			repoAllowlist: ["a/b"],
			lastSyncError: {
				"a/b": {
					at: "2026-04-23T00:00:00Z",
					message: "boom",
					kind: "http-5xx",
				},
			},
		};
		const plugin = makePlugin({ settings });
		const { root } = mountView(plugin);
		const statusCell = root.querySelector("tbody tr td:last-child");
		expect(statusCell?.textContent).toContain("[http-5xx]");
		expect(statusCell?.textContent).toContain("boom");
	});

	test("Refresh button triggers a re-render", () => {
		let counter = 0;
		const plugin = makePlugin({
			settings: { ...DEFAULT_SETTINGS, repoAllowlist: ["a/b"] },
			app: {
				vault: {
					getMarkdownFiles: () => {
						counter++;
						return [];
					},
				},
			},
		});
		const { root } = mountView(plugin);
		const initial = counter;
		const refreshBtn = Array.from(root.querySelectorAll("button")).find(
			(b) => b.textContent === "Refresh",
		);
		refreshBtn?.click();
		expect(counter).toBeGreaterThan(initial);
	});

	test("rate-limit snapshot: pre-sync message when tracker is empty", () => {
		const { root } = mountView(makePlugin());
		expect(root.textContent ?? "").toMatch(
			/no response observed yet/i,
		);
	});

	test("rename handler fires re-render when file moves OUT of the repos root", async () => {
		const handlers: Record<
			string,
			(file: { path: string }, oldPath?: string) => void
		> = {};
		const vault = {
			getMarkdownFiles: () => [],
			on: (
				event: string,
				handler: (file: { path: string }, oldPath?: string) => void,
			) => {
				handlers[event] = handler;
				return { e: event };
			},
		};
		const plugin = makePlugin({
			settings: { ...DEFAULT_SETTINGS, repoAllowlist: ["a/b"] },
			app: { vault },
		});
		const { view } = mountView(plugin);
		// Let onOpen's promise settle (it's the only async path we care about).
		await Promise.resolve();
		const spy = jest.spyOn(view as any, "scheduleRerender");
		// Move: the NEW path is outside the repos root; OLD path is inside.
		handlers.rename?.(
			{ path: "99_ARCHIVE/github/a__b/Issues/1.md" },
			"02_AREAS/GitHub/Repos/a__b/Issues/1.md",
		);
		expect(spy).toHaveBeenCalledTimes(1);
		// Move: NEW path inside, OLD path outside (reverse direction).
		handlers.rename?.(
			{ path: "02_AREAS/GitHub/Repos/a__b/Issues/2.md" },
			"Scratch/2.md",
		);
		expect(spy).toHaveBeenCalledTimes(2);
		// Move entirely outside the repos root: ignored.
		handlers.rename?.(
			{ path: "Scratch/x.md" },
			"Scratch/y.md",
		);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	test("rename handler rejects sibling-prefix paths (trailing slash anchor)", async () => {
		const handlers: Record<
			string,
			(file: { path: string }, oldPath?: string) => void
		> = {};
		const vault = {
			getMarkdownFiles: () => [],
			on: (
				event: string,
				handler: (file: { path: string }, oldPath?: string) => void,
			) => {
				handlers[event] = handler;
				return { e: event };
			},
		};
		const plugin = makePlugin({
			settings: { ...DEFAULT_SETTINGS, repoAllowlist: [] },
			app: { vault },
		});
		const { view } = mountView(plugin);
		await Promise.resolve();
		const spy = jest.spyOn(view as any, "scheduleRerender");
		// 02_AREAS/GitHub/Repos_Other/... is a sibling prefix, not a
		// child of the repos root. Must NOT trigger re-render.
		handlers.create?.({
			path: "02_AREAS/GitHub/Repos_Other/sibling.md",
		});
		expect(spy).not.toHaveBeenCalled();
	});

	test("rate-limit snapshot: displays remaining/limit when populated", () => {
		const plugin = makePlugin({
			rateLimit: {
				getSnapshot: () => ({
					limit: 5000,
					remaining: 4321,
					reset: 0,
					used: 679,
					resource: "core",
					observedAt: 0,
				}),
			},
		});
		const { root } = mountView(plugin);
		expect(root.textContent ?? "").toMatch(/4321\/5000/);
	});
});
