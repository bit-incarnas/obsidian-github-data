/**
 * Settings UI for the GitHub Data plugin.
 *
 * Surface for v0.x:
 * - Token entry (password field)
 * - SecretStorage migration CTA (desktop-only when available)
 * - Test-connection button (first real use of the HTTP bridge from
 *   plugin runtime; hits api.github.com to validate the PAT)
 * - Warning banner when the PAT is in plaintext
 * - Repository allowlist editor
 *
 * Later phases: sync cadence, log level, more.
 */

import {
	Notice,
	PluginSettingTab,
	Setting,
	type App,
} from "obsidian";
import { RequestError } from "@octokit/request-error";

import { createGithubClient } from "../github/client";
import {
	addRepoToAllowlist,
	removeRepoFromAllowlist,
} from "./allowlist";
import {
	MIGRATION_ROTATE_WARNING,
	clearSecret,
	isSecretStorageAvailable,
	migrateTokenToSecretStorage,
	resolveToken,
	setSecret,
} from "./secret-storage";

export interface SettingsTabPluginContract {
	app: App;
	settings: import("./types").GithubDataSettings;
	saveSettings(): Promise<void>;
}

export class GithubDataSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SettingsTabPluginContract,
	) {
		super(app, plugin as unknown as never);
	}

	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "GitHub Data" });

		await this.renderAuthSection(containerEl);
		this.renderAllowlistSection(containerEl);
		this.renderActivitySection(containerEl);
		this.renderAdvancedSection(containerEl);
		this.renderScopeHint(containerEl);
	}

	private renderAdvancedSection(parent: HTMLElement): void {
		parent.createEl("h3", { text: "Advanced" });

		const intro = parent.createDiv({ cls: "setting-item-description" });
		intro.setText(
			"Escape hatches for power users. Defaults are safe; flip these only if you know exactly why.",
		);
		intro.style.marginBottom = "0.75em";

		new Setting(parent)
			.setName("Disable body sanitation")
			.setDesc(
				"Bypass the content sanitizer that neutralizes Templater markers, Dataview inline queries, <script>/<iframe>/<object> tags, event-handler attributes, <img> tags, and javascript:/data:text/html URLs in every issue body, PR description, release note, repo README, and Dependabot advisory synced from GitHub. Wikilink path-escape protection and persist-block marker escaping remain active regardless of this setting.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.disableBodySanitation)
					.onChange(async (value) => {
						this.plugin.settings.disableBodySanitation = value;
						await this.plugin.saveSettings();
						await this.display();
					});
			});

		if (this.plugin.settings.disableBodySanitation) {
			const warn = parent.createDiv({
				cls: "setting-item-description",
			});
			warn.style.color = "var(--text-error, #ef4444)";
			warn.style.border = "1px solid var(--text-error, #ef4444)";
			warn.style.borderRadius = "4px";
			warn.style.padding = "0.5em 0.75em";
			warn.style.marginTop = "0.5em";
			warn.style.marginBottom = "0.75em";
			warn.setText(
				"WARNING: body sanitation is disabled. Every GitHub body synced from this moment forward is written to the vault verbatim, which means a crafted issue body, PR description, release note, README, or Dependabot advisory can execute Templater templates, run Dataview / DataviewJS queries, and ship arbitrary HTML / JavaScript (via <script>, <iframe>, event handlers, or javascript: URLs). Enable only when every allowlisted repo is yours or otherwise fully trusted. Vault-integrity protections (wikilink `..` rewrite, persist-block marker escape) remain active.",
			);
		}
	}

	private renderActivitySection(parent: HTMLElement): void {
		parent.createEl("h3", { text: "Activity" });

		const desc = parent.createDiv({ cls: "setting-item-description" });
		desc.setText(
			"`GitHub Data: Sync activity` pulls your contributionsCollection (commits / PRs / issues / reviews) for the window below, writing one file per active day at `02_AREAS/GitHub/Activity/YYYY-MM/YYYY-MM-DD.md`. Feeds the Telemetry Grid and Heatmap Calendar.",
		);
		desc.style.marginBottom = "0.75em";

		new Setting(parent)
			.setName("Window (days back from today)")
			.setDesc(
				"GitHub caps contributionsCollection at 1 year per query (365). Default 30 is enough for a weekly rhythm; bump to 90/180/365 for deeper history.",
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "365";
				// Track the most recent valid input; commit once on blur
				// rather than saving on every keystroke. Stops transient
				// invalid states (e.g. typing "365" passes through 3, 36)
				// from triggering N separate saves.
				let pending = this.plugin.settings.activitySyncDays;
				text.setValue(String(pending));
				text.onChange((value) => {
					const n = Number.parseInt(value, 10);
					if (Number.isFinite(n) && n >= 1 && n <= 365) {
						pending = n;
					}
				});
				text.inputEl.addEventListener("blur", async () => {
					if (pending === this.plugin.settings.activitySyncDays) return;
					this.plugin.settings.activitySyncDays = pending;
					await this.plugin.saveSettings();
				});
			});
	}

	private renderAllowlistSection(parent: HTMLElement): void {
		parent.createEl("h3", { text: "Repositories" });

		const desc = parent.createDiv({ cls: "setting-item-description" });
		desc.setText(
			"Only repos in this allowlist will be synced or queryable via `github-*` codeblocks. Enter as `owner/repo` (case doesn't matter; entries are lowercased for comparison).",
		);
		desc.style.marginBottom = "0.75em";

		// Add input
		let pending = "";
		new Setting(parent)
			.setName("Add repository")
			.setDesc(
				"Paste or type a GitHub repo identifier. Validated against GitHub's naming rules before adding.",
			)
			.addText((text) => {
				text.inputEl.autocomplete = "off";
				text.setPlaceholder("bit-incarnas/eden");
				text.onChange((value) => {
					pending = value;
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						const result = addRepoToAllowlist(
							this.plugin.settings.repoAllowlist,
							pending,
						);
						if (!result.added) {
							new Notice(result.reason ?? "Could not add.");
							return;
						}
						this.plugin.settings.repoAllowlist = result.list;
						await this.plugin.saveSettings();
						pending = "";
						await this.display();
					});
			});

		// Current allowlist
		const list = this.plugin.settings.repoAllowlist;
		if (list.length === 0) {
			const empty = parent.createDiv({ cls: "setting-item-description" });
			empty.style.fontStyle = "italic";
			empty.setText("No repositories allowlisted yet.");
			return;
		}

		for (const entry of list) {
			new Setting(parent).setName(entry).addButton((btn) => {
				btn.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.repoAllowlist =
							removeRepoFromAllowlist(
								this.plugin.settings.repoAllowlist,
								entry,
							);
						await this.plugin.saveSettings();
						await this.display();
					});
			});
		}
	}

	private async renderAuthSection(parent: HTMLElement): Promise<void> {
		parent.createEl("h3", { text: "Authentication" });

		const s = this.plugin.settings;
		const secretStorageReady = isSecretStorageAvailable(this.plugin.app);
		const currentToken = resolveToken(this.plugin.app, s);
		const hasToken = currentToken.length > 0;

		// Status banner
		const status = parent.createDiv({ cls: "setting-item-description" });
		status.style.marginBottom = "0.75em";
		status.setText(
			this.buildStatusLine(
				hasToken,
				s.useSecretStorage && secretStorageReady,
				secretStorageReady,
			),
		);

		// Plaintext-storage warning (shown when token exists but SecretStorage
		// isn't active)
		if (hasToken && !(s.useSecretStorage && secretStorageReady)) {
			const warn = parent.createDiv({ cls: "setting-item-description" });
			warn.style.color = "var(--text-warning, #f59e0b)";
			warn.style.marginBottom = "0.75em";
			warn.setText(
				secretStorageReady
					? "WARNING: your token is stored in plaintext in data.json. Click 'Migrate to SecretStorage' below to move it to OS-encrypted storage."
					: "WARNING: SecretStorage is not available on this Obsidian build. Your token is stored in plaintext in data.json. Consider adding data.json to your vault's .gitignore.",
			);
		}

		// Token input
		let pendingToken = "";
		new Setting(parent)
			.setName("Personal access token")
			.setDesc(
				"Fine-grained PAT with read-only scopes (Contents, Issues, Pull requests, Metadata, Dependabot alerts, Actions). Create at github.com/settings/personal-access-tokens.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.setPlaceholder(
					hasToken
						? "(a token is already saved -- enter a new one to replace)"
						: "github_pat_...",
				);
				text.onChange((value) => {
					pendingToken = value;
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Save token").onClick(async () => {
					const incoming = pendingToken.trim();
					if (incoming.length === 0) {
						new Notice("Enter a token before clicking Save.");
						return;
					}
					await this.saveToken(incoming);
					pendingToken = "";
					await this.display(); // re-render
				});
			});

		// Migrate button (only shown when migration is possible)
		if (hasToken && secretStorageReady && !s.useSecretStorage) {
			new Setting(parent)
				.setName("Migrate token to SecretStorage")
				.setDesc(
					"Move the plaintext token out of data.json into OS-level encrypted storage. " +
						"IMPORTANT: this does not clean up the token from git history, cloud-sync history, or disk slack. " +
						"Rotate the token in GitHub after migrating.",
				)
				.addButton((btn) => {
					btn.setButtonText("Migrate now")
						.setCta()
						.onClick(async () => {
							const result = migrateTokenToSecretStorage(
								this.plugin.app,
								this.plugin.settings,
							);
							if (!result.migrated) {
								new Notice(
									result.reason ?? "Migration failed.",
								);
								return;
							}
							await this.plugin.saveSettings();
							new Notice(MIGRATION_ROTATE_WARNING, 0);
							await this.display();
						});
				});
		}

		// Test connection
		if (hasToken) {
			new Setting(parent)
				.setName("Test connection")
				.setDesc(
					"Verify the token by calling GET /user. Reads rate-limit headers too.",
				)
				.addButton((btn) => {
					btn.setButtonText("Test now").onClick(async () => {
						await this.runTestConnection(btn.buttonEl);
					});
				});
		}

		// Clear token
		if (hasToken) {
			new Setting(parent)
				.setName("Clear token")
				.setDesc(
					"Remove the saved token from SecretStorage and/or data.json. You'll need to re-enter it to sync again.",
				)
				.addButton((btn) => {
					btn.setButtonText("Clear")
						.setWarning()
						.onClick(async () => {
							await this.clearToken();
							await this.display();
						});
				});
		}
	}

	private renderScopeHint(parent: HTMLElement): void {
		parent.createEl("h3", { text: "Scope" });
		const desc = parent.createDiv({ cls: "setting-item-description" });
		desc.setText(
			"In v0.1 the plugin only reads from GitHub -- no write operations, no outbound calls beyond api.github.com. See docs/data-egress.md in the repo for the full disclosure.",
		);
	}

	private buildStatusLine(
		hasToken: boolean,
		usingSecretStorage: boolean,
		secretStorageReady: boolean,
	): string {
		if (!hasToken) {
			return secretStorageReady
				? "Status: no token saved. SecretStorage is available."
				: "Status: no token saved. SecretStorage is NOT available on this Obsidian build; tokens would be stored in plaintext.";
		}
		if (usingSecretStorage) {
			return "Status: token in SecretStorage (OS-encrypted).";
		}
		return secretStorageReady
			? "Status: token in plaintext. SecretStorage is available -- migrate below."
			: "Status: token in plaintext. SecretStorage is NOT available on this build.";
	}

	private async saveToken(rawToken: string): Promise<void> {
		const s = this.plugin.settings;
		const app = this.plugin.app;

		if (s.useSecretStorage && isSecretStorageAvailable(app)) {
			setSecret(app, s.secretTokenName, rawToken);
			s.token = "";
			await this.plugin.saveSettings();
			new Notice("Token saved to SecretStorage.");
			return;
		}

		// Plaintext path -- either SecretStorage unavailable or user hasn't
		// migrated yet. Store in data.json and warn.
		s.token = rawToken;
		await this.plugin.saveSettings();
		new Notice(
			isSecretStorageAvailable(app)
				? "Token saved (plaintext). Click 'Migrate to SecretStorage' to protect it."
				: "Token saved (plaintext). SecretStorage is unavailable on this build; consider gitignoring data.json.",
		);
	}

	private async clearToken(): Promise<void> {
		const s = this.plugin.settings;
		const app = this.plugin.app;

		if (s.useSecretStorage && isSecretStorageAvailable(app)) {
			clearSecret(app, s.secretTokenName);
		}

		s.token = "";
		s.useSecretStorage = false;
		await this.plugin.saveSettings();
		new Notice("Token cleared.");
	}

	private async runTestConnection(buttonEl: HTMLElement): Promise<void> {
		const originalText = buttonEl.textContent ?? "Test now";
		buttonEl.setAttribute("disabled", "true");
		buttonEl.textContent = "Testing...";
		try {
			const token = resolveToken(
				this.plugin.app,
				this.plugin.settings,
			);
			if (!token) {
				new Notice("No token set. Save a token first.");
				return;
			}
			const client = createGithubClient({ token });
			const res = await client.rest.users.getAuthenticated();
			const remaining = res.headers["x-ratelimit-remaining"] ?? "?";
			const limit = res.headers["x-ratelimit-limit"] ?? "?";
			new Notice(
				`Connected as ${res.data.login}. Rate limit: ${remaining}/${limit} remaining this hour.`,
				8000,
			);
		} catch (err) {
			if (err instanceof RequestError) {
				if (err.status === 401) {
					new Notice(
						"Authentication failed (401). Token is invalid or revoked.",
						8000,
					);
				} else if (err.status === 403) {
					const ssoRequired = err.response?.headers?.[
						"x-github-sso"
					];
					new Notice(
						ssoRequired
							? "403: SAML SSO authorization required. Authorize the token in GitHub org settings."
							: `403: ${err.message}`,
						8000,
					);
				} else {
					new Notice(
						`GitHub returned ${err.status}: ${err.message}`,
						8000,
					);
				}
			} else {
				const msg =
					err instanceof Error ? err.message : String(err);
				new Notice(`Connection failed: ${msg}`, 8000);
			}
		} finally {
			buttonEl.removeAttribute("disabled");
			buttonEl.textContent = originalText;
		}
	}
}
