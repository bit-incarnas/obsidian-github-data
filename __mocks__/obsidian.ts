/**
 * Minimal hand-written mock of the Obsidian API for Jest.
 *
 * Written from scratch for this plugin (see NOTICES). Covers the API surface
 * the plugin actually uses; extend as new APIs are consumed.
 *
 * Typed loosely on purpose -- tests import the real Obsidian types for
 * annotations and cast into the mock where runtime behavior matters.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class Plugin {
	app: any;
	manifest: any;

	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}

	loadData: any = jest.fn(() => Promise.resolve({}));
	saveData: any = jest.fn(() => Promise.resolve());
	addCommand: any = jest.fn();
	addRibbonIcon: any = jest.fn();
	addStatusBarItem: any = jest.fn(() => ({
		setText: jest.fn(),
		empty: jest.fn(),
	}));
	addSettingTab: any = jest.fn();
	registerEvent: any = jest.fn();
	registerInterval: any = jest.fn((id: number) => id);
	registerMarkdownPostProcessor: any = jest.fn();
	registerMarkdownCodeBlockProcessor: any = jest.fn();
	registerView: any = jest.fn();
	registerDomEvent: any = jest.fn();
	addChild: any = jest.fn();
}

export class Notice {
	constructor(
		public message: string | DocumentFragment,
		public timeout?: number,
	) {}
}

export class Modal {
	app: any;
	constructor(app: any) {
		this.app = app;
	}
	open: any = jest.fn();
	close: any = jest.fn();
	onOpen: any = jest.fn();
	onClose: any = jest.fn();
}

export class WorkspaceLeaf {
	view: any = null;
	setViewState: any = jest.fn(async (_state: unknown) => {});
	getViewState: any = jest.fn(() => ({}));
	detach: any = jest.fn();
}

export class ItemView {
	app: any;
	leaf: any;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	constructor(leaf: any) {
		this.leaf = leaf;
		this.app = leaf?.app ?? null;
		this.containerEl = document.createElement("div");
		this.contentEl = document.createElement("div");
		this.containerEl.appendChild(this.contentEl);
	}
	// Prototype methods so subclass overrides take effect.
	// (Using `= jest.fn()` class-field syntax would set instance fields
	// that shadow the subclass prototype methods.)
	getViewType(): string {
		return "";
	}
	getDisplayText(): string {
		return "";
	}
	getIcon(): string {
		return "";
	}
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
	registerEvent(_e: unknown): void {}
	registerInterval(id: number): number {
		return id;
	}
	registerDomEvent(): void {}
	addChild(): void {}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: HTMLElement;
	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = document.createElement("div");
	}
	display: any = jest.fn();
	hide: any = jest.fn();
}

export class Setting {
	settingEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		this.settingEl = document.createElement("div");
		containerEl.appendChild(this.settingEl);
	}
	setName: any = jest.fn(() => this);
	setDesc: any = jest.fn(() => this);
	addText: any = jest.fn(() => this);
	addToggle: any = jest.fn(() => this);
	addDropdown: any = jest.fn(() => this);
	addButton: any = jest.fn(() => this);
}

export const requestUrl: any = jest.fn();

export const parseYaml = (source: string): unknown => {
	try {
		return JSON.parse(source);
	} catch {
		const obj: Record<string, string> = {};
		for (const line of source.split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}
		return obj;
	}
};

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isMacOS: false,
	isLinux: true,
	isWin: false,
	isIosApp: false,
	isAndroidApp: false,
};

export const setIcon: any = jest.fn();

export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "md";
}

export class TFolder {
	path = "";
	name = "";
	children: unknown[] = [];
}

/**
 * FileSystemAdapter mock -- real class exists only on desktop. Tests that
 * need `adapter instanceof FileSystemAdapter` construct an instance here
 * and monkey-patch `getBasePath`.
 */
export class FileSystemAdapter {
	getBasePath(): string {
		return "/";
	}
}

/**
 * Shape of the (undocumented) SecretStorage API. Tests that need it
 * inject an instance onto `app.secretStorage`.
 */
export type SecretStorageApi = {
	getSecret(key: string): string | null | Promise<string | null>;
	setSecret(key: string, value: string): void | Promise<void>;
	removeSecret?(key: string): void | Promise<void>;
};
