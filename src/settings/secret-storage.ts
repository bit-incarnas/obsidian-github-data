/**
 * Wrappers around Obsidian's `app.secretStorage` API (Obsidian 1.11.4+).
 *
 * The API is backed by Electron's `safeStorage` (OS keychain: macOS
 * Keychain, Linux Secret Service, Windows Credential Manager).
 *
 * All methods on `SecretStorage` are synchronous per the public type, but
 * we wrap in try/catch because the API throws on invalid IDs (see the
 * constraint: "lowercase alphanumeric with optional dashes").
 *
 * There is no `removeSecret` method. We clear by writing an empty string.
 */

import type { App } from "obsidian";

import type { GithubDataSettings } from "./types";

export function isSecretStorageAvailable(app: App): boolean {
	return typeof app.secretStorage?.getSecret === "function";
}

export function getSecret(app: App, id: string): string | null {
	if (!app.secretStorage) return null;
	try {
		return app.secretStorage.getSecret(id);
	} catch {
		return null;
	}
}

export function setSecret(app: App, id: string, value: string): void {
	if (!app.secretStorage) {
		throw new Error("SecretStorage is not available on this Obsidian build.");
	}
	app.secretStorage.setSecret(id, value);
}

/**
 * Best-effort clear. No `removeSecret` in the public API, so we zero the
 * value. Swallows errors -- callers only use this as part of a "forget me"
 * flow where failure is recoverable.
 */
export function clearSecret(app: App, id: string): void {
	if (!app.secretStorage) return;
	try {
		app.secretStorage.setSecret(id, "");
	} catch {
		// swallow
	}
}

/**
 * Resolve the active PAT for making requests. Prefers SecretStorage when
 * configured; falls back to plaintext `token` when not.
 *
 * Returns an empty string when no token is available (rather than throwing)
 * so callers can decide whether to surface a user notice or silently skip.
 */
export function resolveToken(
	app: App,
	settings: GithubDataSettings,
): string {
	if (settings.useSecretStorage && settings.secretTokenName) {
		const fromSecret = getSecret(app, settings.secretTokenName);
		if (fromSecret && fromSecret.length > 0) return fromSecret;
	}
	return settings.token ?? "";
}

/**
 * Move a plaintext token into SecretStorage. Clears the plaintext field on
 * success. Caller is responsible for persisting settings + surfacing the
 * rotation-warning copy to the user (per Security Invariants).
 */
export function migrateTokenToSecretStorage(
	app: App,
	settings: GithubDataSettings,
): { migrated: boolean; reason?: string } {
	if (!isSecretStorageAvailable(app)) {
		return { migrated: false, reason: "SecretStorage is not available." };
	}
	if (!settings.token || settings.token.length === 0) {
		return { migrated: false, reason: "No plaintext token to migrate." };
	}
	if (!settings.secretTokenName || settings.secretTokenName.length === 0) {
		return {
			migrated: false,
			reason: "Secret token name is not configured.",
		};
	}

	setSecret(app, settings.secretTokenName, settings.token);

	settings.useSecretStorage = true;
	settings.token = "";

	return { migrated: true };
}

/**
 * Copy required user-facing warning for the migration UI. Centralized here
 * so the exact wording stays consistent with docs/data-schema.md.
 */
export const MIGRATION_ROTATE_WARNING =
	"Token moved to SecretStorage. IMPORTANT: the original value has already been written to data.json and may survive in git history, cloud-sync history, and disk slack. Rotate this token in GitHub settings now -- the old value is considered leaked.";
