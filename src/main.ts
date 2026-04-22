import { Notice, Plugin } from "obsidian";

import { GithubDataSettingTab } from "./settings/settings-tab";
import { maybeShowDevVaultNotice } from "./settings/dev-vault-notice";
import { resolveToken } from "./settings/secret-storage";
import { DEFAULT_SETTINGS, mergeSettings, type GithubDataSettings } from "./settings/types";

export default class GithubDataPlugin extends Plugin {
	settings: GithubDataSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new GithubDataSettingTab(this.app, this));

		this.addCommand({
			id: "ping",
			name: "Ping (scaffold smoke test)",
			callback: () => {
				new Notice("GitHub Data: scaffold alive");
				console.log("[github-data] ping");
			},
		});

		this.app.workspace.onLayoutReady(() => {
			void this.onAppReady();
		});
	}

	onunload(): void {
		// Registered events/intervals auto-clean via the Plugin base class.
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<GithubDataSettings> | null;
		this.settings = mergeSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Resolved PAT for the HTTP layer. Empty string when no token is set. */
	getToken(): string {
		return resolveToken(this.app, this.settings);
	}

	private async onAppReady(): Promise<void> {
		// Dev-vault .git check runs once per install; the flag is persisted
		// in settings so we don't spam the user on every load.
		await maybeShowDevVaultNotice({
			app: this.app,
			alreadyShown: this.settings.devVaultGitNoticeShown,
			onShown: async () => {
				this.settings.devVaultGitNoticeShown = true;
				await this.saveSettings();
			},
		});
	}
}
