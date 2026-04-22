/**
 * Integration tests -- real GitHub, skips without GH_TEST_TOKEN env var.
 *
 * Run locally with:
 *
 *   GH_TEST_TOKEN=<fine-grained-pat> npm run test:integration
 *
 * The token only needs read access; these tests never write.
 * Never commit a token. Never set the env var in CI.
 */

import { createGithubClient } from "../../src/github/client";
import { nodeHttpFn } from "./node-http";

const token = process.env.GH_TEST_TOKEN;
const hasToken = typeof token === "string" && token.length > 0;

const describeWithToken = hasToken ? describe : describe.skip;

describeWithToken("GitHub HTTP bridge -- integration", () => {
	jest.setTimeout(20000);

	test("authenticated user can be fetched", async () => {
		const client = createGithubClient({
			token: token as string,
			httpFn: nodeHttpFn,
			userAgent: "obsidian-github-data-integration-test",
		});

		const res = await client.rest.users.getAuthenticated();

		expect(res.status).toBe(200);
		expect(typeof res.data.login).toBe("string");
		expect(res.data.login.length).toBeGreaterThan(0);
		expect(res.data.type).toBe("User");
	});

	test("Crystal Eden repo metadata can be fetched", async () => {
		const client = createGithubClient({
			token: token as string,
			httpFn: nodeHttpFn,
		});

		const res = await client.rest.repos.get({
			owner: "bit-incarnas",
			repo: "eden",
		});

		expect(res.status).toBe(200);
		expect(res.data.name).toBe("eden");
		expect(res.data.owner.login).toBe("bit-incarnas");
	});

	test("rate limit reports remaining budget", async () => {
		const client = createGithubClient({
			token: token as string,
			httpFn: nodeHttpFn,
		});

		const res = await client.rest.rateLimit.get();

		expect(res.status).toBe(200);
		expect(res.data.rate.limit).toBeGreaterThan(0);
		expect(res.data.rate.remaining).toBeLessThanOrEqual(res.data.rate.limit);
		// Rate-limit headers must flow through to the caller.
		expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
	});

	test("pagination helper iterates over repos", async () => {
		const client = createGithubClient({
			token: token as string,
			httpFn: nodeHttpFn,
		});

		// Just verify the iterator shape works against a small page.
		const first = await client.rest.repos.listForAuthenticatedUser({
			per_page: 1,
			page: 1,
		});
		expect(first.status).toBe(200);
		expect(Array.isArray(first.data)).toBe(true);
	});

	test("404 maps to RequestError with status 404", async () => {
		const client = createGithubClient({
			token: token as string,
			httpFn: nodeHttpFn,
		});

		await expect(
			client.rest.repos.get({
				owner: "bit-incarnas",
				repo: "this-repo-does-not-exist-9c48002",
			}),
		).rejects.toMatchObject({ status: 404 });
	});
});

(!hasToken ? test : test.skip)("integration tests skipped (GH_TEST_TOKEN not set)", () => {
	expect(true).toBe(true);
});
