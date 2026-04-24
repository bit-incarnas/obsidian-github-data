/**
 * Sync Progress view -- an Obsidian ItemView rendering per-repo sync
 * status. Reads only from plugin settings + the vault markdown file
 * list (via `app.vault.getMarkdownFiles()`); zero network I/O on open
 * or refresh so the view stays inside the plugin's data-egress
 * contract.
 *
 * Layout:
 * - Header: "GitHub Data sync status" + Refresh button.
 * - Optional banner: "Body sanitation disabled" when the toggle is on.
 * - Optional banner: "Auth circuit open" + Reset button when tripped.
 * - Rate-limit snapshot.
 * - Per-repo table with last-synced, entity counts, and any recorded
 *   failure reason.
 *
 * The view subscribes to vault create/delete events scoped under the
 * repos root and debounces re-renders so dogfood sync commands reflect
 * in the panel without user action.
 */

import { ItemView, type WorkspaceLeaf } from "obsidian";

import type { CircuitBreaker } from "../github/circuit-breaker";
import type { RateLimitTracker } from "../github/rate-limit";
import type { GithubDataSettings } from "../settings/types";
import {
	REPOS_ROOT,
	buildRepoStatusRows,
	formatRelativeTime,
	type RepoStatusRow,
} from "./sync-progress-data";

export const VIEW_TYPE_SYNC_PROGRESS = "github-data-sync-progress";

/**
 * Narrow plugin contract the view relies on. Keeps the dependency
 * surface explicit and testable without importing the full plugin.
 */
export interface SyncProgressViewPlugin {
	app: {
		vault: {
			getMarkdownFiles(): Array<{ path: string }>;
			on?: unknown;
		};
		workspace?: unknown;
	};
	settings: GithubDataSettings;
	circuit: Pick<CircuitBreaker, "isOpen" | "getReason">;
	rateLimit: Pick<RateLimitTracker, "getSnapshot">;
	resetCircuit(): Promise<void>;
}

const REFRESH_DEBOUNCE_MS = 300;

export class SyncProgressView extends ItemView {
	private debounceHandle: ReturnType<typeof setTimeout> | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: SyncProgressViewPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SYNC_PROGRESS;
	}

	getDisplayText(): string {
		return "GitHub Data sync";
	}

	getIcon(): string {
		return "refresh-cw";
	}

	async onOpen(): Promise<void> {
		this.render();
		// Auto-refresh when a synced file lands in / leaves the repos tree.
		// Rename is special: Obsidian passes `(file, oldPath)` so we also
		// fire the re-render when a file is moved OUT of the repos root
		// (otherwise the count would be stale until manual refresh).
		const rootPrefix = `${REPOS_ROOT.toLowerCase()}/`;
		const isUnderReposRoot = (path?: string): boolean =>
			!!path && path.toLowerCase().startsWith(rootPrefix);
		const vault = this.plugin.app.vault as unknown as {
			on?: (
				event: string,
				handler: (file: { path: string }, oldPath?: string) => void,
			) => { e?: unknown };
		};
		if (typeof vault.on === "function") {
			for (const event of ["create", "delete", "rename"] as const) {
				const ref = vault.on(
					event,
					(file: { path: string }, oldPath?: string) => {
						if (
							!isUnderReposRoot(file?.path) &&
							!isUnderReposRoot(oldPath)
						) {
							return;
						}
						this.scheduleRerender();
					},
				);
				if (ref) this.registerEvent(ref as never);
			}
		}
	}

	async onClose(): Promise<void> {
		if (this.debounceHandle) {
			clearTimeout(this.debounceHandle);
			this.debounceHandle = null;
		}
	}

	private scheduleRerender(): void {
		if (this.debounceHandle) clearTimeout(this.debounceHandle);
		this.debounceHandle = setTimeout(() => {
			this.debounceHandle = null;
			this.render();
		}, REFRESH_DEBOUNCE_MS);
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("github-data-sync-progress");

		this.renderHeader(root);
		this.renderBanners(root);
		this.renderRateLimit(root);
		this.renderRepoTable(root);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "setting-item" });
		header.style.alignItems = "center";
		header.style.display = "flex";
		header.style.justifyContent = "space-between";
		header.createEl("h3", { text: "GitHub Data sync status" }).style.margin = "0";
		const btn = header.createEl("button", { text: "Refresh" });
		btn.onclick = () => this.render();
	}

	private renderBanners(root: HTMLElement): void {
		if (this.plugin.settings.disableBodySanitation) {
			const banner = root.createDiv({
				cls: "setting-item-description",
			});
			banner.style.color = "var(--text-error, #ef4444)";
			banner.style.border = "1px solid var(--text-error, #ef4444)";
			banner.style.borderRadius = "4px";
			banner.style.padding = "0.5em 0.75em";
			banner.style.marginBottom = "0.75em";
			banner.setText(
				"Body sanitation is DISABLED. Templater / Dataview / <script> neutralization is bypassed on every synced body. Vault-integrity passes still run. Flip the setting off in GitHub Data -> Advanced when you're done.",
			);
		}

		const circuitOpen = this.plugin.circuit.isOpen();
		if (circuitOpen) {
			const banner = root.createDiv({ cls: "setting-item" });
			banner.style.border = "1px solid var(--text-error, #ef4444)";
			banner.style.borderRadius = "4px";
			banner.style.padding = "0.5em 0.75em";
			banner.style.marginBottom = "0.75em";

			const text = banner.createDiv();
			text.style.color = "var(--text-error, #ef4444)";
			text.style.flex = "1";
			const reason = this.plugin.circuit.getReason() ?? "unknown reason";
			text.setText(`Auth circuit OPEN: ${reason}`);

			const resetBtn = banner.createEl("button", {
				text: "Reset circuit",
			});
			resetBtn.onclick = async () => {
				await this.plugin.resetCircuit();
				this.render();
			};
		}
	}

	private renderRateLimit(root: HTMLElement): void {
		const snap = this.plugin.rateLimit.getSnapshot();
		const desc = root.createDiv({ cls: "setting-item-description" });
		desc.style.marginBottom = "0.75em";
		if (!snap) {
			desc.setText(
				"Rate limit: no response observed yet (run a sync to populate).",
			);
			return;
		}
		const resetAt = snap.reset > 0 ? new Date(snap.reset * 1000) : null;
		const resetLabel = resetAt
			? `resets at ${resetAt.toLocaleTimeString()}`
			: "reset time unknown";
		desc.setText(
			`Rate limit: ${snap.remaining}/${snap.limit} remaining (${resetLabel}).`,
		);
	}

	private renderRepoTable(root: HTMLElement): void {
		const files = this.plugin.app.vault.getMarkdownFiles();
		const rows = buildRepoStatusRows(this.plugin.settings, files);
		if (rows.length === 0) {
			const empty = root.createDiv({ cls: "setting-item-description" });
			empty.style.fontStyle = "italic";
			empty.setText(
				"No repositories allowlisted. Add `owner/repo` entries in Settings -> GitHub Data.",
			);
			return;
		}

		const table = root.createEl("table");
		table.style.width = "100%";
		table.style.borderCollapse = "collapse";
		table.style.marginTop = "0.5em";
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		for (const label of [
			"Repo",
			"Last synced",
			"Issues",
			"PRs",
			"Releases",
			"Dependabot",
			"Status",
		]) {
			const th = headerRow.createEl("th", { text: label });
			th.style.textAlign = "left";
			th.style.padding = "0.25em 0.5em";
			th.style.borderBottom = "1px solid var(--background-modifier-border)";
		}

		const tbody = table.createEl("tbody");
		for (const row of rows) {
			this.renderRow(tbody, row);
		}
	}

	private renderRow(tbody: HTMLElement, row: RepoStatusRow): void {
		const tr = tbody.createEl("tr");
		for (const cell of [
			row.repo,
			formatRelativeTime(row.lastSyncedAt),
			String(row.counts.issues),
			String(row.counts.prs),
			String(row.counts.releases),
			String(row.counts.dependabot),
		]) {
			const td = tr.createEl("td", { text: cell });
			td.style.padding = "0.25em 0.5em";
			td.style.borderBottom = "1px solid var(--background-modifier-border)";
		}
		// Status cell -- either OK or the error message with a kind badge.
		const status = tr.createEl("td");
		status.style.padding = "0.25em 0.5em";
		status.style.borderBottom = "1px solid var(--background-modifier-border)";
		if (row.lastError) {
			status.style.color = "var(--text-error, #ef4444)";
			status.setText(`[${row.lastError.kind}] ${row.lastError.message}`);
			status.setAttribute(
				"title",
				`recorded ${formatRelativeTime(row.lastError.at)}`,
			);
		} else if (row.lastSyncedAt) {
			status.setText("ok");
		} else {
			status.setText("never synced");
			status.style.fontStyle = "italic";
		}
	}
}
