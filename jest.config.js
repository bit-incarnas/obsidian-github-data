/** @type {import('jest').Config} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	moduleNameMapper: {
		"^obsidian$": "<rootDir>/__mocks__/obsidian.ts",
	},
	testMatch: ["**/src/**/*.test.ts", "**/__tests__/**/*.test.ts"],
	transform: {
		"^.+\\.tsx?$": [
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
					strict: true,
					skipLibCheck: true,
					types: ["node", "jest"],
				},
			},
		],
	},
};
