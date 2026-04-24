/**
 * jsdom polyfill for the HTMLElement prototype extensions that Obsidian
 * ships at runtime (`createDiv`, `createEl`, `empty`, `setText`,
 * `addClass` / `removeClass`, `toggleClass`, `setAttr`, `detach`).
 *
 * These aren't part of the obsidian module -- they're added directly to
 * `HTMLElement.prototype` when Obsidian starts. Tests that render any
 * view / settings-tab DOM need them present. Loaded via
 * `setupFilesAfterEnv` in jest.config.js.
 *
 * Loose-typed on purpose: tests import real Obsidian types for
 * annotations, and rely on this module only for runtime behavior.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface CreateOptions {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean>;
	href?: string;
	type?: string;
	title?: string;
}

function applyOptions(el: HTMLElement, options?: CreateOptions): void {
	if (!options) return;
	if (options.cls) {
		const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
		for (const c of classes) {
			if (c) el.classList.add(c);
		}
	}
	if (options.text !== undefined) el.textContent = options.text;
	if (options.attr) {
		for (const [k, v] of Object.entries(options.attr)) {
			el.setAttribute(k, String(v));
		}
	}
	if (options.href !== undefined) el.setAttribute("href", options.href);
	if (options.type !== undefined) el.setAttribute("type", options.type);
	if (options.title !== undefined) el.setAttribute("title", options.title);
}

// Node-env test files (docblock `@jest-environment node`) run without
// jsdom, so HTMLElement is absent. Bail gracefully so those suites
// aren't broken by this setup file.
if (typeof HTMLElement === "undefined") {
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	(globalThis as unknown as { __dom_ext_noop?: true }).__dom_ext_noop = true;
}

const proto =
	typeof HTMLElement === "undefined"
		? ({} as any)
		: (HTMLElement.prototype as any);

if (!proto.createEl) {
	proto.createEl = function <K extends keyof HTMLElementTagNameMap>(
		this: HTMLElement,
		tag: K,
		options?: CreateOptions,
		callback?: (el: HTMLElementTagNameMap[K]) => void,
	): HTMLElementTagNameMap[K] {
		const el = document.createElement(tag);
		applyOptions(el, options);
		this.appendChild(el);
		callback?.(el);
		return el;
	};
}

if (!proto.createDiv) {
	proto.createDiv = function (
		this: HTMLElement,
		options?: CreateOptions | string,
		callback?: (el: HTMLDivElement) => void,
	): HTMLDivElement {
		const normalized: CreateOptions | undefined =
			typeof options === "string" ? { cls: options } : options;
		return (this as any).createEl("div", normalized, callback);
	};
}

if (!proto.createSpan) {
	proto.createSpan = function (
		this: HTMLElement,
		options?: CreateOptions | string,
		callback?: (el: HTMLSpanElement) => void,
	): HTMLSpanElement {
		const normalized: CreateOptions | undefined =
			typeof options === "string" ? { cls: options } : options;
		return (this as any).createEl("span", normalized, callback);
	};
}

if (!proto.empty) {
	proto.empty = function (this: HTMLElement): void {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
}

if (!proto.setText) {
	proto.setText = function (this: HTMLElement, text: string): void {
		this.textContent = text;
	};
}

if (!proto.addClass) {
	proto.addClass = function (this: HTMLElement, ...classes: string[]): void {
		for (const c of classes) if (c) this.classList.add(c);
	};
}

if (!proto.removeClass) {
	proto.removeClass = function (
		this: HTMLElement,
		...classes: string[]
	): void {
		for (const c of classes) if (c) this.classList.remove(c);
	};
}

if (!proto.toggleClass) {
	proto.toggleClass = function (
		this: HTMLElement,
		cls: string,
		force?: boolean,
	): void {
		this.classList.toggle(cls, force);
	};
}

if (!proto.setAttr) {
	proto.setAttr = function (
		this: HTMLElement,
		key: string,
		value: string | number | boolean,
	): void {
		this.setAttribute(key, String(value));
	};
}

if (!proto.detach) {
	proto.detach = function (this: HTMLElement): void {
		this.parentNode?.removeChild(this);
	};
}

export {};
