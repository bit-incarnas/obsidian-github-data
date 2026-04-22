/**
 * Dev-vault .git detection.
 *
 * Surfaced as a one-time Notice when the plugin loads inside a vault whose
 * filesystem path (or any ancestor up to a sensible cap) contains a `.git`.
 * Purpose: warn the user that if SecretStorage is unavailable and the PAT
 * ends up in `data.json`, it'll land in the vault's git history.
 *
 * Desktop-only; mobile platforms don't expose a filesystem path and don't
 * run git locally in the same way.
 *
 * The filesystem check is dependency-injected (`PathExistsFn`) so unit
 * tests can drive it without touching a real disk. Default impl uses
 * Node's synchronous `fs.existsSync`, available in Obsidian's Electron
 * runtime.
 */

import {
	FileSystemAdapter,
	Notice,
	Platform,
	type App,
} from "obsidian";

export type PathExistsFn = (path: string) => boolean;

const MAX_PARENT_WALK = 10;

export function defaultPathExists(filePath: string): boolean {
	try {
		// `require` works in Electron renderer; import would break ESM bundle
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs") as { existsSync: (p: string) => boolean };
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}

function getVaultBasePath(app: App): string | null {
	if (!Platform.isDesktop) return null;
	const adapter = app.vault?.adapter;
	if (!adapter || !(adapter instanceof FileSystemAdapter)) return null;
	try {
		return adapter.getBasePath();
	} catch {
		return null;
	}
}

function joinPath(dir: string, leaf: string): string {
	if (dir.endsWith("/") || dir.endsWith("\\")) return `${dir}${leaf}`;
	// Handle both POSIX and Windows separators without requiring `path` module
	const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
	return `${dir}${sep}${leaf}`;
}

function parentPath(dir: string): string {
	const lastSlash = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
	if (lastSlash <= 0) return dir;
	return dir.slice(0, lastSlash);
}

export function isVaultUnderGit(
	app: App,
	pathExists: PathExistsFn = defaultPathExists,
): boolean {
	const base = getVaultBasePath(app);
	if (!base) return false;

	let current = base;
	for (let i = 0; i < MAX_PARENT_WALK; i++) {
		if (pathExists(joinPath(current, ".git"))) return true;
		const next = parentPath(current);
		if (next === current) return false;
		current = next;
	}
	return false;
}

export interface MaybeShowDevVaultNoticeArgs {
	app: App;
	alreadyShown: boolean;
	onShown: () => Promise<void> | void;
	pathExists?: PathExistsFn;
	noticeClass?: typeof Notice;
}

/**
 * Show the dev-vault warning if applicable. Idempotent across calls: once
 * `alreadyShown` is true (persisted by the caller in settings), we do
 * nothing. This is a user-visible notice only; not a blocker.
 */
export async function maybeShowDevVaultNotice({
	app,
	alreadyShown,
	onShown,
	pathExists,
	noticeClass,
}: MaybeShowDevVaultNoticeArgs): Promise<boolean> {
	if (alreadyShown) return false;
	if (!isVaultUnderGit(app, pathExists)) return false;

	const NoticeImpl = noticeClass ?? Notice;
	const message =
		"GitHub Data: your vault appears to be under git. If SecretStorage " +
		"is unavailable on this device, your PAT will be stored in " +
		"data.json and land in your vault's git history. Add " +
		"`.obsidian/plugins/github-data/data.json` to your .gitignore.";
	// 0 = sticky; user dismisses manually
	new NoticeImpl(message, 0);

	await onShown();
	return true;
}
