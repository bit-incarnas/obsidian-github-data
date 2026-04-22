import type { App } from "obsidian";
import {
	isSecretStorageAvailable,
	getSecret,
	setSecret,
	clearSecret,
	resolveToken,
	migrateTokenToSecretStorage,
} from "./secret-storage";
import { DEFAULT_SETTINGS } from "./types";

interface FakeSecretStorage {
	store: Map<string, string>;
	getSecret: jest.Mock;
	setSecret: jest.Mock;
	listSecrets: jest.Mock;
}

function makeSecretStorage(initial: Record<string, string> = {}): FakeSecretStorage {
	const store = new Map(Object.entries(initial));
	return {
		store,
		getSecret: jest.fn((key: string) => store.get(key) ?? null),
		setSecret: jest.fn((key: string, value: string) => {
			if (value === "") {
				store.delete(key);
			} else {
				store.set(key, value);
			}
		}),
		listSecrets: jest.fn(() => Array.from(store.keys())),
	};
}

function makeApp(secretStorage?: FakeSecretStorage): App {
	return { secretStorage } as unknown as App;
}

describe("secret-storage", () => {
	describe("isSecretStorageAvailable", () => {
		test("true when the API is present", () => {
			expect(isSecretStorageAvailable(makeApp(makeSecretStorage()))).toBe(
				true,
			);
		});

		test("false when the API is absent", () => {
			expect(isSecretStorageAvailable(makeApp(undefined))).toBe(false);
		});
	});

	describe("getSecret", () => {
		test("returns stored secret", () => {
			const ss = makeSecretStorage({ foo: "bar" });
			expect(getSecret(makeApp(ss), "foo")).toBe("bar");
		});

		test("returns null when key missing", () => {
			expect(getSecret(makeApp(makeSecretStorage()), "missing")).toBeNull();
		});

		test("returns null when API throws (e.g., invalid id)", () => {
			const throwing: FakeSecretStorage = {
				store: new Map(),
				getSecret: jest.fn(() => {
					throw new Error("bad id");
				}),
				setSecret: jest.fn(),
				listSecrets: jest.fn(() => []),
			};
			expect(getSecret(makeApp(throwing), "x")).toBeNull();
		});

		test("returns null when API absent", () => {
			expect(getSecret(makeApp(undefined), "x")).toBeNull();
		});
	});

	describe("setSecret", () => {
		test("writes to the store", () => {
			const ss = makeSecretStorage();
			setSecret(makeApp(ss), "k", "v");
			expect(ss.setSecret).toHaveBeenCalledWith("k", "v");
		});

		test("throws when API absent", () => {
			expect(() => setSecret(makeApp(undefined), "k", "v")).toThrow(
				/not available/i,
			);
		});
	});

	describe("clearSecret", () => {
		test("zeroes the stored secret", () => {
			const ss = makeSecretStorage({ foo: "bar" });
			clearSecret(makeApp(ss), "foo");
			expect(ss.setSecret).toHaveBeenCalledWith("foo", "");
		});

		test("silently no-ops when API absent", () => {
			expect(() => clearSecret(makeApp(undefined), "foo")).not.toThrow();
		});
	});

	describe("resolveToken", () => {
		test("prefers SecretStorage when enabled", () => {
			const ss = makeSecretStorage({ "github-data-pat": "secret-pat" });
			const settings = {
				...DEFAULT_SETTINGS,
				useSecretStorage: true,
				token: "plaintext-leftover",
			};
			expect(resolveToken(makeApp(ss), settings)).toBe("secret-pat");
		});

		test("falls back to plaintext when SecretStorage returns nothing", () => {
			const ss = makeSecretStorage();
			const settings = {
				...DEFAULT_SETTINGS,
				useSecretStorage: true,
				token: "plaintext",
			};
			expect(resolveToken(makeApp(ss), settings)).toBe("plaintext");
		});

		test("returns plaintext when SecretStorage is disabled", () => {
			const settings = {
				...DEFAULT_SETTINGS,
				useSecretStorage: false,
				token: "plaintext",
			};
			expect(resolveToken(makeApp(undefined), settings)).toBe("plaintext");
		});

		test("returns empty string when no token is stored anywhere", () => {
			const settings = { ...DEFAULT_SETTINGS };
			expect(resolveToken(makeApp(undefined), settings)).toBe("");
		});
	});

	describe("migrateTokenToSecretStorage", () => {
		test("migrates plaintext -> SecretStorage and clears plaintext", () => {
			const ss = makeSecretStorage();
			const settings = {
				...DEFAULT_SETTINGS,
				token: "original",
				useSecretStorage: false,
			};
			const result = migrateTokenToSecretStorage(makeApp(ss), settings);
			expect(result.migrated).toBe(true);
			expect(ss.setSecret).toHaveBeenCalledWith(
				"github-data-pat",
				"original",
			);
			expect(settings.token).toBe("");
			expect(settings.useSecretStorage).toBe(true);
		});

		test("refuses when SecretStorage unavailable", () => {
			const settings = { ...DEFAULT_SETTINGS, token: "x" };
			const result = migrateTokenToSecretStorage(
				makeApp(undefined),
				settings,
			);
			expect(result.migrated).toBe(false);
			expect(result.reason).toMatch(/not available/i);
			expect(settings.token).toBe("x");
		});

		test("refuses when no plaintext token", () => {
			const ss = makeSecretStorage();
			const settings = { ...DEFAULT_SETTINGS, token: "" };
			const result = migrateTokenToSecretStorage(makeApp(ss), settings);
			expect(result.migrated).toBe(false);
			expect(result.reason).toMatch(/no plaintext/i);
		});
	});
});
