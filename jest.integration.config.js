/** @type {import('jest').Config} */
const base = require("./jest.config.js");

module.exports = {
	...base,
	testEnvironment: "node",
	testMatch: ["**/tests/integration/**/*.integration.test.ts"],
	testPathIgnorePatterns: ["/node_modules/"],
};
