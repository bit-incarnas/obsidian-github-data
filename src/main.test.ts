import type { App, PluginManifest } from "obsidian";
import GithubDataPlugin from "./main";

describe("GithubDataPlugin", () => {
	const app = {
		workspace: {
			onLayoutReady: (cb: () => void) => cb(),
		},
		vault: { adapter: {} },
	} as unknown as App;
	const manifest: PluginManifest = {
		id: "github-data",
		name: "GitHub Data",
		version: "0.0.1",
		minAppVersion: "1.0.0",
		description: "test",
		author: "bit-incarnas",
		authorUrl: "https://github.com/bit-incarnas",
		isDesktopOnly: false,
		dir: "/test/.obsidian/plugins/github-data",
	};

	test("constructs", () => {
		const plugin = new GithubDataPlugin(app, manifest);
		expect(plugin).toBeTruthy();
	});

	test("loads default settings on onload", async () => {
		const plugin = new GithubDataPlugin(app, manifest);
		await plugin.onload();
		expect(plugin.settings.schemaVersion).toBe(1);
		expect(plugin.settings.token).toBe("");
		expect(plugin.settings.useSecretStorage).toBe(false);
		expect(plugin.settings.repoAllowlist).toEqual([]);
	});

	test("merges loaded settings over defaults", async () => {
		const plugin = new GithubDataPlugin(app, manifest);
		(plugin.loadData as jest.Mock).mockResolvedValueOnce({
			token: "existing",
			repoAllowlist: ["bit-incarnas/eden"],
		});
		await plugin.onload();
		expect(plugin.settings.token).toBe("existing");
		expect(plugin.settings.repoAllowlist).toEqual(["bit-incarnas/eden"]);
		expect(plugin.settings.syncCadenceMinutes).toBe(15); // default
	});

	test("registers settings tab", async () => {
		const plugin = new GithubDataPlugin(app, manifest);
		await plugin.onload();
		expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
	});

	test("registers ping + sync commands", async () => {
		const plugin = new GithubDataPlugin(app, manifest);
		await plugin.onload();
		expect(plugin.addCommand).toHaveBeenCalledTimes(2);
		const ids = (plugin.addCommand as jest.Mock).mock.calls.map(
			(c) => c[0].id,
		);
		expect(ids).toContain("ping");
		expect(ids).toContain("sync-repo-profiles");
	});

	test("getToken returns empty string when no token stored", async () => {
		const plugin = new GithubDataPlugin(app, manifest);
		await plugin.onload();
		expect(plugin.getToken()).toBe("");
	});

	test("getToken returns plaintext when stored", async () => {
		const plugin = new GithubDataPlugin(app, manifest);
		(plugin.loadData as jest.Mock).mockResolvedValueOnce({
			token: "plaintext-pat",
		});
		await plugin.onload();
		expect(plugin.getToken()).toBe("plaintext-pat");
	});
});
