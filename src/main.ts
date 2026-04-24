import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";

import { registerCodeblockProcessors } from "./codeblock/processor";
import { CircuitBreaker, CircuitOpenError } from "./github/circuit-breaker";
import { createGithubClient, type GithubClient } from "./github/client";
import { Semaphore } from "./github/concurrency";
import { RateLimitTracker } from "./github/rate-limit";
import { parseRepoPath } from "./paths/sanitize";
import { GithubDataSettingTab } from "./settings/settings-tab";
import { maybeShowDevVaultNotice } from "./settings/dev-vault-notice";
import { resolveToken } from "./settings/secret-storage";
import {
	DEFAULT_SETTINGS,
	mergeSettings,
	type GithubDataSettings,
	type SyncErrorKind,
} from "./settings/types";
import {
	SyncProgressView,
	VIEW_TYPE_SYNC_PROGRESS,
} from "./ui/sync-progress-view";
import { syncActivity } from "./sync/activity-writer";
import { syncRepoDependabotAlerts } from "./sync/dependabot-writer";
import { syncRepoIssues } from "./sync/issue-writer";
import { syncRepoPullRequests } from "./sync/pr-writer";
import { syncRepoReleases } from "./sync/release-writer";
import { syncRepoProfile } from "./sync/repo-profile-writer";
import { ObsidianVaultWriter } from "./vault/writer";

/**
 * Classify an arbitrary sync failure into (message, kind) for the view.
 * Messages are truncated so a runaway GitHub payload can't bloat data.json.
 */
function classifySyncError(reason: unknown): {
	message: string;
	kind: SyncErrorKind;
} {
	const message = describeSyncError(reason);
	const kind = kindOfSyncError(reason);
	return { message, kind };
}

const MAX_ERROR_MESSAGE_LENGTH = 240;

function describeSyncError(reason: unknown): string {
	let raw: string;
	if (reason == null) raw = "unknown error";
	else if (typeof reason === "string") raw = reason;
	else if (reason instanceof Error) raw = reason.message || reason.name;
	else raw = String(reason);
	if (raw.length <= MAX_ERROR_MESSAGE_LENGTH) return raw;
	return `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function kindOfSyncError(reason: unknown): SyncErrorKind {
	if (reason instanceof CircuitOpenError) return "circuit-open";
	const status = extractErrorStatus(reason);
	if (typeof status === "number") {
		if (status >= 400 && status < 500) return "http-4xx";
		if (status >= 500 && status < 600) return "http-5xx";
	}
	if (reason instanceof TypeError) return "network";
	if (
		typeof reason === "string" &&
		/network|fetch failed|socket|ECONN|ENOTFOUND/i.test(reason)
	) {
		return "network";
	}
	return "unknown";
}

function extractErrorStatus(reason: unknown): number | undefined {
	if (!reason || typeof reason !== "object") return undefined;
	const status = (reason as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

export default class GithubDataPlugin extends Plugin {
	settings: GithubDataSettings = DEFAULT_SETTINGS;

	/**
	 * Plugin-lifetime HTTP state shared across every sync command. A
	 * single RateLimitTracker means the budget is global across syncs
	 * (writers don't silently double-count their concurrency). A single
	 * CircuitBreaker means 401 twice in any command trips for all later
	 * commands -- the user acts once and resets once. A single Semaphore
	 * caps parallel in-flight requests across all writers.
	 */
	readonly rateLimit = new RateLimitTracker();
	readonly circuit = new CircuitBreaker();
	private readonly concurrency = new Semaphore();

	async onload(): Promise<void> {
		await this.loadSettings();

		if (this.settings.disableBodySanitation) {
			console.warn(
				"[github-data] body sanitation DISABLED via settings -- Templater/Dataview/script neutralization bypassed on every synced body. Vault-integrity passes (wikilink `..` rewrite, persist-block escape) still run.",
			);
		}

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

		// Codeblock processors: github-issue / github-pr / github-release /
		// github-dependabot. Queries run against the synced vault tree via
		// metadataCache; no network calls on render.
		registerCodeblockProcessors(this, {
			app: this.app,
			getSettings: () => this.settings,
		});

		// Sync Progress view: read-only dashboard over plugin settings +
		// vault markdown files. Zero network I/O on open (data-egress
		// policy compliance).
		this.registerView(
			VIEW_TYPE_SYNC_PROGRESS,
			(leaf) => new SyncProgressView(leaf, this),
		);
		this.addRibbonIcon("refresh-cw", "GitHub Data: sync progress", () => {
			void this.openSyncProgress();
		});
		this.addCommand({
			id: "open-sync-progress",
			name: "Open sync progress",
			callback: () => {
				void this.openSyncProgress();
			},
		});

		this.app.workspace.onLayoutReady(() => {
			void this.onAppReady();
		});
	}

	/**
	 * Reveal the Sync Progress view: focus an existing leaf of the
	 * right type, or open one in the right sidebar.
	 */
	async openSyncProgress(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_SYNC_PROGRESS,
		);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0] as WorkspaceLeaf);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({
			type: VIEW_TYPE_SYNC_PROGRESS,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf as WorkspaceLeaf);
	}

	/**
	 * Close the auth circuit and refresh any open progress view. Called
	 * by the Reset button in the Sync Progress view; the state lives on
	 * plugin lifetime so resetting from anywhere clears subsequent
	 * request blocks.
	 */
	async resetCircuit(): Promise<void> {
		this.circuit.reset();
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

		const client = this.createClient(token);
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

		const client = this.createClient(token);
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
				{
					client,
					writer,
					allowlist,
					disableBodySanitation: this.settings.disableBodySanitation,
				},
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
			await this.recordSyncOutcome(entry, result.ok, result.reason);
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

		const client = this.createClient(token);
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
				disableBodySanitation: this.settings.disableBodySanitation,
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
			await this.recordSyncOutcome(entry, result.ok, result.reason);
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

		const client = this.createClient(token);
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
				{
					client,
					writer,
					allowlist,
					disableBodySanitation: this.settings.disableBodySanitation,
				},
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
			await this.recordSyncOutcome(entry, result.ok, result.reason);
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

		const client = this.createClient(token);
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
				disableBodySanitation: this.settings.disableBodySanitation,
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
			await this.recordSyncOutcome(entry, result.ok, result.reason);
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

		const client = this.createClient(token);
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
				{
					client,
					writer,
					allowlist,
					disableBodySanitation: this.settings.disableBodySanitation,
				},
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
			await this.recordSyncOutcome(entry, result.ok, result.reason);
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

	/**
	 * Build a GitHub client backed by the plugin's shared rate-limit
	 * state. Every sync command funnels through here so 401 tripping,
	 * backoff budgets, and concurrency caps are consistent.
	 */
	private createClient(token: string): GithubClient {
		return createGithubClient({
			token,
			rateLimit: this.rateLimit,
			circuit: this.circuit,
			concurrency: this.concurrency,
		});
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<GithubDataSettings> | null;
		this.settings = mergeSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Persist a sync failure reason for a repo so the Sync Progress view
	 * can surface it. Safe to call with an unknown error -- the reason
	 * is coerced to a bounded string and a matching kind.
	 */
	async recordSyncError(repo: string, reason: unknown): Promise<void> {
		const { message, kind } = classifySyncError(reason);
		this.settings.lastSyncError[repo] = {
			at: new Date().toISOString(),
			message,
			kind,
		};
		await this.saveSettings();
	}

	/** Clear any persisted failure for a repo. Called on successful sync. */
	async clearSyncError(repo: string): Promise<void> {
		if (!(repo in this.settings.lastSyncError)) return;
		delete this.settings.lastSyncError[repo];
		await this.saveSettings();
	}

	/** Resolved PAT for the HTTP layer. Empty string when no token is set. */
	getToken(): string {
		return resolveToken(this.app, this.settings);
	}

	/**
	 * Funnel point for a single-repo sync result. Persists the failure
	 * reason on a miss and clears any stale entry on a hit. Keeps the
	 * five command loops uniform and keeps the settings-mutation logic
	 * out of the writers themselves.
	 */
	private async recordSyncOutcome(
		repo: string,
		ok: boolean,
		reason: unknown,
	): Promise<void> {
		if (ok) {
			await this.clearSyncError(repo);
			return;
		}
		await this.recordSyncError(repo, reason);
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
