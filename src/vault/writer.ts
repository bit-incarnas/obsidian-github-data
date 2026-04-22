/**
 * Vault-write abstraction.
 *
 * The sync engine calls through `VaultWriter` rather than `app.vault.*`
 * directly, for the same reason the HTTP layer calls through `HttpFn`
 * (see src/github/http.ts): tests inject an in-memory implementation so
 * sync logic is pure-unit-testable without booting Obsidian.
 *
 * The surface is small on purpose: just the ops the sync engine needs.
 * Defensive folder creation is bundled in here because it's common to
 * every writer.
 */

import {
	TFile,
	type App,
	type FrontMatterCache,
} from "obsidian";

export interface VaultWriter {
	ensureFolder(path: string): Promise<void>;
	pathExists(path: string): Promise<boolean>;
	readFile(path: string): Promise<string>;
	/**
	 * Create or overwrite a file at `path` with `body`. The caller is
	 * responsible for calling `updateFrontmatter` if frontmatter needs
	 * to be set / merged atomically after write.
	 */
	writeFile(path: string, body: string): Promise<void>;
	/**
	 * Atomically update the file's YAML frontmatter via Obsidian's
	 * `processFrontMatter` (or equivalent). The `mutate` callback is
	 * invoked with the parsed frontmatter object and may mutate it
	 * in place.
	 */
	updateFrontmatter(
		path: string,
		mutate: (fm: Record<string, unknown>) => void,
	): Promise<void>;
}

export class ObsidianVaultWriter implements VaultWriter {
	constructor(private app: App) {}

	async ensureFolder(path: string): Promise<void> {
		if (path === "" || path === "/") return;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) return; // folder or file already exists at this path

		try {
			await this.app.vault.createFolder(path);
		} catch (err) {
			// Race: another write may have created it between check + create.
			// Retry lookup after a microtask.
			await new Promise((resolve) => setTimeout(resolve, 10));
			const retry = this.app.vault.getAbstractFileByPath(path);
			if (!retry) throw err;
		}
	}

	async pathExists(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(path) !== null;
	}

	async readFile(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found: ${path}`);
		}
		return this.app.vault.read(file);
	}

	async writeFile(path: string, body: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, body);
			return;
		}
		await this.app.vault.create(path, body);
	}

	async updateFrontmatter(
		path: string,
		mutate: (fm: Record<string, unknown>) => void,
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found for frontmatter update: ${path}`);
		}
		await this.app.fileManager.processFrontMatter(
			file,
			mutate as (fm: FrontMatterCache) => void,
		);
	}
}

/**
 * In-memory VaultWriter implementation for tests. State is a simple
 * Map keyed by path; frontmatter lives as a plain object alongside the
 * body. Folder tracking is implicit -- any write "ensures" the folder
 * since there's no real filesystem to care about.
 */
export class InMemoryVaultWriter implements VaultWriter {
	public files = new Map<
		string,
		{ frontmatter: Record<string, unknown>; body: string }
	>();
	public folders = new Set<string>();

	async ensureFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async pathExists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}

	async readFile(path: string): Promise<string> {
		const entry = this.files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry.body;
	}

	async writeFile(path: string, body: string): Promise<void> {
		const existing = this.files.get(path);
		this.files.set(path, {
			body,
			frontmatter: existing?.frontmatter ?? {},
		});
	}

	async updateFrontmatter(
		path: string,
		mutate: (fm: Record<string, unknown>) => void,
	): Promise<void> {
		const entry = this.files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		mutate(entry.frontmatter);
	}
}
