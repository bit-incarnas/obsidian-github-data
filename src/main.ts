import { Notice, Plugin } from "obsidian";

import { createGithubClient } from "./github/client";
import { parseRepoPath } from "./paths/sanitize";
import { GithubDataSettingTab } from "./settings/settings-tab";
import { maybeShowDevVaultNotice } from "./settings/dev-vault-notice";
import { resolveToken } from "./settings/secret-storage";
import { DEFAULT_SETTINGS, mergeSettings, type GithubDataSettings } from "./settings/types";
import { syncActivity } from "./sync/activity-writer";
import { syncRepoDependabotAlerts } from "./sync/dependabot-writer";
import { syncRepoIssues } from "./sync/issue-writer";
import { syncRepoPullRequests } from "./sync/pr-writer";
import { syncRepoReleases } from "./sync/release-writer";
import { syncRepoProfile } from "./sync/repo-profile-writer";
import { ObsidianVaultWriter } from "./vault/writer";

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

		this.addCommand({
			id: "sync-repo-profiles",
			name: "Sync all repo profiles",
			callback: () => {
				void this.syncAllRepoProfiles();
			},
		});

		this.addCommand({
			id: "sync-open-issues",
			name: "Sync all open issues",
			callback: () => {
				void this.syncAllOpenIssues();
			},
		});

		this.addCommand({
			id: "sync-open-prs",
			name: "Sync all open pull requests",
			callback: () => {
				void this.syncAllOpenPullRequests();
			},
		});

		this.addCommand({
			id: "sync-releases",
			name: "Sync all releases",
			callback: () => {
				void this.syncAllReleases();
			},
		});

		this.addCommand({
			id: "sync-dependabot",
			name: "Sync all open Dependabot alerts",
			callback: () => {
				void this.syncAllDependabotAlerts();
			},
		});

		this.addCommand({
			id: "sync-activity",
			name: "Sync activity",
			callback: () => {
				void this.syncActivityFeed();
			},
		});

		this.app.workspace.onLayoutReady(() => {
			void this.onAppReady();
		});
	}

	async syncActivityFeed(): Promise<void> {
		const token = this.getToken();
		if (!token) {
			new Notice(
				"No GitHub token set. Add one in Settings -> GitHub Data.",
			);
			return;
		}

		const windowDays = this.settings.activitySyncDays;
		new Notice(
			`GitHub Data: syncing activity (last ${windowDays} day${windowDays === 1 ? "" : "s"})...`,
		);

		const client = createGithubClient({ token });
		const writer = new ObsidianVaultWriter(this.app);

		const result = await syncActivity({ client, writer, windowDays });

		if (!result.ok) {
			console.warn("[github-data] activity sync failed:", result.reason);
			new Notice(
				`GitHub Data: activity sync failed -- ${result.reason ?? "unknown error"}`,
				8000,
			);
			return;
		}

		const wrote = result.writtenCount ?? 0;
		const failed = result.failedCount ?? 0;
		const days = result.totalDays ?? 0;
		new Notice(
			`GitHub Data: activity synced. ${wrote} day file(s) written across ${days} active day(s). ${failed} failed.`,
			6000,
		);
	}

	async syncAllDependabotAlerts(): Promise<void> {
		const token = this.getToken();
		if (!token) {
			new Notice(
				"No GitHub token set. Add one in Settings -> GitHub Data.",
			);
			return;
		}
		const allowlist = this.settings.repoAllowlist;
		if (allowlist.length === 0) {
			new Notice(
				"No repos in the allowlist. Add one in Settings -> GitHub Data.",
			);
			return;
		}

		new Notice(
			`GitHub Data: fetching Dependabot alerts for ${allowlist.length} repo(s)...`,
		);

		const client = createGithubClient({ token });
		const writer = new ObsidianVaultWriter(this.app);

		let synced = 0;
		let failed = 0;
		let skipped = 0;
		for (const entry of allowlist) {
			const parsed = parseRepoPath(entry);
			if (!parsed.valid) {
				console.warn("[github-data] skipping invalid entry", entry);
				failed++;
				continue;
			}
			const result = await syncRepoDependabotAlerts(
				parsed.owner,
				parsed.repo,
				{ client, writer, allowlist },
			);
			if (result.ok) {
				if (result.skipped === "alerts-disabled") {
					skipped++;
				} else {
					synced += result.syncedCount ?? 0;
					failed += result.failedCount ?? 0;
				}
			} else {
				console.warn(
					`[github-data] Dependabot sync failed for ${entry}:`,
					result.reason,
				);
				failed++;
			}
		}

		const skippedNote = skipped > 0 ? `, ${skipped} had alerts disabled` : "";
		new Notice(
			`GitHub Data: Dependabot sync complete. ${synced} synced, ${failed} failed${skippedNote}.`,
			6000,
		);
	}

	async syncAllReleases(): Promise<void> {
		const token = this.getToken();
		if (!token) {
			new Notice(
				"No GitHub token set. Add one in Settings -> GitHub Data.",
			);
			return;
		}
		const allowlist = this.settings.repoAllowlist;
		if (allowlist.length === 0) {
			new Notice(
				"No repos in the allowlist. Add one in Settings -> GitHub Data.",
			);
			return;
		}

		new Notice(
			`GitHub Data: fetching releases for ${allowlist.length} repo(s)...`,
		);

		const client = createGithubClient({ token });
		const writer = new ObsidianVaultWriter(this.app);

		let synced = 0;
		let failed = 0;
		for (const entry of allowlist) {
			const parsed = parseRepoPath(entry);
			if (!parsed.valid) {
				console.warn("[github-data] skipping invalid entry", entry);
				failed++;
				continue;
			}
			const result = await syncRepoReleases(parsed.owner, parsed.repo, {
				client,
				writer,
				allowlist,
			});
			if (result.ok) {
				synced += result.syncedCount ?? 0;
				failed += result.failedCount ?? 0;
			} else {
				console.warn(
					`[github-data] release sync failed for ${entry}:`,
					result.reason,
				);
				failed++;
			}
		}

		new Notice(
			`GitHub Data: release sync complete. ${synced} synced, ${failed} failed.`,
			6000,
		);
	}

	async syncAllOpenPullRequests(): Promise<void> {
		const token = this.getToken();
		if (!token) {
			new Notice(
				"No GitHub token set. Add one in Settings -> GitHub Data.",
			);
			return;
		}
		const allowlist = this.settings.repoAllowlist;
		if (allowlist.length === 0) {
			new Notice(
				"No repos in the allowlist. Add one in Settings -> GitHub Data.",
			);
			return;
		}

		new Notice(
			`GitHub Data: fetching open PRs for ${allowlist.length} repo(s)...`,
		);

		const client = createGithubClient({ token });
		const writer = new ObsidianVaultWriter(this.app);

		let synced = 0;
		let failed = 0;
		for (const entry of allowlist) {
			const parsed = parseRepoPath(entry);
			if (!parsed.valid) {
				console.warn("[github-data] skipping invalid entry", entry);
				failed++;
				continue;
			}
			const result = await syncRepoPullRequests(
				parsed.owner,
				parsed.repo,
				{ client, writer, allowlist },
			);
			if (result.ok) {
				synced += result.syncedCount ?? 0;
				failed += result.failedCount ?? 0;
			} else {
				console.warn(
					`[github-data] PR sync failed for ${entry}:`,
					result.reason,
				);
				failed++;
			}
		}

		new Notice(
			`GitHub Data: PR sync complete. ${synced} synced, ${failed} failed.`,
			6000,
		);
	}

	async syncAllOpenIssues(): Promise<void> {
		const token = this.getToken();
		if (!token) {
			new Notice(
				"No GitHub token set. Add one in Settings -> GitHub Data.",
			);
			return;
		}
		const allowlist = this.settings.repoAllowlist;
		if (allowlist.length === 0) {
			new Notice(
				"No repos in the allowlist. Add one in Settings -> GitHub Data.",
			);
			return;
		}

		new Notice(
			`GitHub Data: fetching open issues for ${allowlist.length} repo(s)...`,
		);

		const client = createGithubClient({ token });
		const writer = new ObsidianVaultWriter(this.app);

		let synced = 0;
		let failed = 0;
		for (const entry of allowlist) {
			const parsed = parseRepoPath(entry);
			if (!parsed.valid) {
				console.warn("[github-data] skipping invalid entry", entry);
				failed++;
				continue;
			}
			const result = await syncRepoIssues(parsed.owner, parsed.repo, {
				client,
				writer,
				allowlist,
			});
			if (result.ok) {
				synced += result.syncedCount ?? 0;
				failed += result.failedCount ?? 0;
			} else {
				console.warn(
					`[github-data] issue sync failed for ${entry}:`,
					result.reason,
				);
				failed++;
			}
		}

		new Notice(
			`GitHub Data: issue sync complete. ${synced} synced, ${failed} failed.`,
			6000,
		);
	}

	async syncAllRepoProfiles(): Promise<void> {
		const token = this.getToken();
		if (!token) {
			new Notice(
				"No GitHub token set. Add one in Settings -> GitHub Data.",
			);
			return;
		}
		const allowlist = this.settings.repoAllowlist;
		if (allowlist.length === 0) {
			new Notice(
				"No repos in the allowlist. Add one in Settings -> GitHub Data.",
			);
			return;
		}

		new Notice(`GitHub Data: syncing ${allowlist.length} repo profile(s)...`);

		const client = createGithubClient({ token });
		const writer = new ObsidianVaultWriter(this.app);

		let ok = 0;
		let failed = 0;
		for (const entry of allowlist) {
			const parsed = parseRepoPath(entry);
			if (!parsed.valid) {
				console.warn("[github-data] skipping invalid entry", entry);
				failed++;
				continue;
			}
			const result = await syncRepoProfile(
				parsed.owner,
				parsed.repo,
				{ client, writer, allowlist },
			);
			if (result.ok) {
				ok++;
				this.settings.lastSyncedAt[entry] = result.syncedAt ?? "";
			} else {
				console.warn(
					`[github-data] sync failed for ${entry}:`,
					result.reason,
				);
				failed++;
			}
		}

		await this.saveSettings();

		new Notice(
			`GitHub Data: sync complete. ${ok} ok, ${failed} failed.`,
			6000,
		);
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
