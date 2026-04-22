/**
 * Settings UI for the GitHub Data plugin.
 *
 * Surface for v0.x:
 * - Token entry (password field)
 * - SecretStorage migration CTA (desktop-only when available)
 * - Test-connection button (first real use of the HTTP bridge from
 *   plugin runtime; hits api.github.com to validate the PAT)
 * - Warning banner when the PAT is in plaintext
 *
 * Later phases: repo allowlist editor, sync cadence, log level, more.
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
		this.renderScopeHint(containerEl);
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
