import { Notice, Plugin } from "obsidian";

interface GithubDataSettings {
	schemaVersion: number;
}

const DEFAULT_SETTINGS: GithubDataSettings = {
	schemaVersion: 1,
};

export default class GithubDataPlugin extends Plugin {
	settings: GithubDataSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "ping",
			name: "Ping (scaffold smoke test)",
			callback: () => {
				new Notice("GitHub Data: scaffold alive");
				console.log("[github-data] ping");
			},
		});
	}

	onunload(): void {
		// Cleanup registered via this.registerEvent / registerInterval auto-unregisters.
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
