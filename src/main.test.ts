import type { App, PluginManifest } from "obsidian";
import GithubDataPlugin from "./main";

describe("GithubDataPlugin scaffold", () => {
	const app = {} as App;
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
	});

	test("registers the scaffold ping command", async () => {
		const plugin = new GithubDataPlugin(app, manifest);
		await plugin.onload();
		expect(plugin.addCommand).toHaveBeenCalledTimes(1);
		const call = (plugin.addCommand as jest.Mock).mock.calls[0][0];
		expect(call.id).toBe("ping");
	});
});
