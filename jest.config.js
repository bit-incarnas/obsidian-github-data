/** @type {import('jest').Config} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	setupFilesAfterEnv: ["<rootDir>/__mocks__/dom-extensions.ts"],
	moduleNameMapper: {
		"^obsidian$": "<rootDir>/__mocks__/obsidian.ts",
	},
	// Default run = unit tests only. Integration tests live under tests/integration/
	// and run via `npm run test:integration` (requires GH_TEST_TOKEN).
	testMatch: ["**/src/**/*.test.ts"],
	testPathIgnorePatterns: [
		"/node_modules/",
		"/tests/integration/",
	],
	transform: {
		"^.+\\.(ts|tsx|js|mjs)$": [
			"ts-jest",
			{
				tsconfig: {
					rootDir: ".",
					module: "commonjs",
					target: "es2020",
					moduleResolution: "bundler",
					ignoreDeprecations: "6.0",
					esModuleInterop: true,
					isolatedModules: true,
					allowJs: true,
					strict: true,
					skipLibCheck: true,
					types: ["node", "jest"],
				},
			},
		],
	},
	// Octokit v7+ and its transitive deps ship as pure ESM. Jest defaults to
	// ignoring node_modules for transform; explicitly include these so ts-jest
	// converts them to CJS at test time.
	transformIgnorePatterns: [
		"node_modules/(?!(?:@octokit|universal-user-agent|before-after-hook|fast-content-type-parse)/)",
	],
};
