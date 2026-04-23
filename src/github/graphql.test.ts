/**
 * @jest-environment node
 */
import type { GithubClient } from "./client";
import {
	fetchContributionsCollection,
	fetchViewerLogin,
} from "./graphql";

/**
 * The GraphQL helpers are thin wrappers over `client.graphql()`, so the
 * tests mock the client's graphql function directly rather than going
 * through the full Octokit + fetch stack. Transport-level correctness
 * is covered by client.test.ts.
 */
function mockClient(
	graphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown>,
): GithubClient {
	return { graphql } as unknown as GithubClient;
}

describe("fetchViewerLogin", () => {
	test("returns the authenticated user's login", async () => {
		const client = mockClient(async () => ({ viewer: { login: "bit-incarnas" } }));
		const login = await fetchViewerLogin(client);
		expect(login).toBe("bit-incarnas");
	});

	test("passes a query string through to client.graphql", async () => {
		const graphql = jest.fn(
			async (_query: string, _variables?: Record<string, unknown>) => ({
				viewer: { login: "x" },
			}),
		);
		const client = mockClient(graphql);
		await fetchViewerLogin(client);
		expect(graphql).toHaveBeenCalledTimes(1);
		expect(graphql.mock.calls[0][0]).toContain("viewer");
	});

	test("propagates errors from the GraphQL call", async () => {
		const client = mockClient(async () => {
			throw new Error("Bad credentials");
		});
		await expect(fetchViewerLogin(client)).rejects.toThrow("Bad credentials");
	});
});

describe("fetchContributionsCollection", () => {
	const collection = {
		totalCommitContributions: 5,
		totalIssueContributions: 1,
		totalPullRequestContributions: 2,
		totalPullRequestReviewContributions: 0,
		commitContributionsByRepository: [],
		pullRequestContributions: { nodes: [] },
		issueContributions: { nodes: [] },
		pullRequestReviewContributions: { nodes: [] },
	};

	test("parses a successful response", async () => {
		const client = mockClient(async () => ({
			user: { contributionsCollection: collection },
		}));
		const result = await fetchContributionsCollection(
			client,
			"bit-incarnas",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
		);
		expect(result).toEqual(collection);
	});

	test("passes login + window as variables", async () => {
		const graphql = jest.fn(
			async (_query: string, _variables?: Record<string, unknown>) => ({
				user: { contributionsCollection: collection },
			}),
		);
		const client = mockClient(graphql);
		await fetchContributionsCollection(
			client,
			"bit-incarnas",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
		);
		const vars = graphql.mock.calls[0][1];
		expect(vars).toEqual({
			login: "bit-incarnas",
			from: "2026-04-01T00:00:00Z",
			to: "2026-04-22T00:00:00Z",
		});
	});

	test("throws when user is not found", async () => {
		const client = mockClient(async () => ({ user: null }));
		await expect(
			fetchContributionsCollection(
				client,
				"ghost",
				"2026-04-01T00:00:00Z",
				"2026-04-22T00:00:00Z",
			),
		).rejects.toThrow(/User not found/);
	});

	test("propagates GraphQL errors", async () => {
		const client = mockClient(async () => {
			throw new Error("rate limited");
		});
		await expect(
			fetchContributionsCollection(
				client,
				"x",
				"2026-04-01T00:00:00Z",
				"2026-04-22T00:00:00Z",
			),
		).rejects.toThrow("rate limited");
	});

	test("embeds the expected selection set in the query", async () => {
		const graphql = jest.fn(
			async (_query: string, _variables?: Record<string, unknown>) => ({
				user: { contributionsCollection: collection },
			}),
		);
		const client = mockClient(graphql);
		await fetchContributionsCollection(
			client,
			"x",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
		);
		const query = String(graphql.mock.calls[0][0]);
		expect(query).toContain("contributionsCollection");
		expect(query).toContain("commitContributionsByRepository");
		expect(query).toContain("pullRequestContributions");
		expect(query).toContain("issueContributions");
		expect(query).toContain("pullRequestReviewContributions");
		expect(query).toContain("mergedAt");
		expect(query).toContain("closedAt");
	});
});
