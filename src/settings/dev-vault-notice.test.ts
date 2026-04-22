import type { App } from "obsidian";
import { FileSystemAdapter, Platform } from "obsidian";
import {
	isVaultUnderGit,
	maybeShowDevVaultNotice,
	type PathExistsFn,
} from "./dev-vault-notice";

function makeDesktopApp(basePath: string): App {
	const adapter = new FileSystemAdapter();
	(adapter as unknown as { getBasePath: () => string }).getBasePath = () =>
		basePath;
	return {
		vault: { adapter },
	} as unknown as App;
}

function makePathExists(paths: string[]): PathExistsFn {
	return (p: string) => paths.includes(p);
}

describe("dev-vault-notice", () => {
	beforeEach(() => {
		Platform.isDesktop = true;
	});

	describe("isVaultUnderGit", () => {
		test("true when .git exists directly in vault base", () => {
			const app = makeDesktopApp("/home/user/my-vault");
			const exists = makePathExists(["/home/user/my-vault/.git"]);
			expect(isVaultUnderGit(app, exists)).toBe(true);
		});

		test("true when .git exists in an ancestor directory", () => {
			const app = makeDesktopApp("/home/user/repos/my-vault");
			const exists = makePathExists(["/home/user/repos/.git"]);
			expect(isVaultUnderGit(app, exists)).toBe(true);
		});

		test("false when no .git found in any ancestor", () => {
			const app = makeDesktopApp("/home/user/my-vault");
			const exists = makePathExists([]);
			expect(isVaultUnderGit(app, exists)).toBe(false);
		});

		test("false on mobile platforms", () => {
			Platform.isDesktop = false;
			const app = makeDesktopApp("/home/user/my-vault");
			const exists = makePathExists(["/home/user/my-vault/.git"]);
			expect(isVaultUnderGit(app, exists)).toBe(false);
		});

		test("false when adapter is not FileSystemAdapter (e.g., mobile)", () => {
			const app = {
				vault: { adapter: {} },
			} as unknown as App;
			const exists = makePathExists([]);
			expect(isVaultUnderGit(app, exists)).toBe(false);
		});
	});

	describe("maybeShowDevVaultNotice", () => {
		test("shows notice and calls onShown when conditions met", async () => {
			const app = makeDesktopApp("/home/user/my-vault");
			const exists = makePathExists(["/home/user/my-vault/.git"]);
			const onShown = jest.fn();
			const NoticeSpy = jest.fn();

			const shown = await maybeShowDevVaultNotice({
				app,
				alreadyShown: false,
				onShown,
				pathExists: exists,
				noticeClass: NoticeSpy as never,
			});

			expect(shown).toBe(true);
			expect(NoticeSpy).toHaveBeenCalledTimes(1);
			expect(onShown).toHaveBeenCalledTimes(1);
		});

		test("no-op when already shown", async () => {
			const app = makeDesktopApp("/home/user/my-vault");
			const exists = makePathExists(["/home/user/my-vault/.git"]);
			const onShown = jest.fn();
			const NoticeSpy = jest.fn();

			const shown = await maybeShowDevVaultNotice({
				app,
				alreadyShown: true,
				onShown,
				pathExists: exists,
				noticeClass: NoticeSpy as never,
			});

			expect(shown).toBe(false);
			expect(NoticeSpy).not.toHaveBeenCalled();
			expect(onShown).not.toHaveBeenCalled();
		});

		test("no-op when vault is not under git", async () => {
			const app = makeDesktopApp("/home/user/my-vault");
			const exists = makePathExists([]);
			const onShown = jest.fn();
			const NoticeSpy = jest.fn();

			const shown = await maybeShowDevVaultNotice({
				app,
				alreadyShown: false,
				onShown,
				pathExists: exists,
				noticeClass: NoticeSpy as never,
			});

			expect(shown).toBe(false);
			expect(NoticeSpy).not.toHaveBeenCalled();
			expect(onShown).not.toHaveBeenCalled();
		});
	});
});
