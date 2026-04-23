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

function mainResponse(overrides: {
	prs?: { nodes: unknown[]; hasNextPage?: boolean; endCursor?: string | null };
	issues?: { nodes: unknown[]; hasNextPage?: boolean; endCursor?: string | null };
	reviews?: { nodes: unknown[]; hasNextPage?: boolean; endCursor?: string | null };
	commitsByRepo?: unknown[];
	totals?: {
		commits?: number;
		issues?: number;
		prs?: number;
		reviews?: number;
	};
} = {}) {
	return {
		user: {
			contributionsCollection: {
				totalCommitContributions: overrides.totals?.commits ?? 0,
				totalIssueContributions: overrides.totals?.issues ?? 0,
				totalPullRequestContributions: overrides.totals?.prs ?? 0,
				totalPullRequestReviewContributions:
					overrides.totals?.reviews ?? 0,
				commitContributionsByRepository: overrides.commitsByRepo ?? [],
				pullRequestContributions: {
					pageInfo: {
						endCursor: overrides.prs?.endCursor ?? null,
						hasNextPage: overrides.prs?.hasNextPage ?? false,
					},
					nodes: overrides.prs?.nodes ?? [],
				},
				issueContributions: {
					pageInfo: {
						endCursor: overrides.issues?.endCursor ?? null,
						hasNextPage: overrides.issues?.hasNextPage ?? false,
					},
					nodes: overrides.issues?.nodes ?? [],
				},
				pullRequestReviewContributions: {
					pageInfo: {
						endCursor: overrides.reviews?.endCursor ?? null,
						hasNextPage: overrides.reviews?.hasNextPage ?? false,
					},
					nodes: overrides.reviews?.nodes ?? [],
				},
			},
		},
	};
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
	test("parses a simple response (no pagination)", async () => {
		const response = mainResponse({
			totals: { commits: 5, prs: 2, issues: 1, reviews: 0 },
		});
		const client = mockClient(async () => response);
		const result = await fetchContributionsCollection(
			client,
			"bit-incarnas",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
		);
		expect(result.totalCommitContributions).toBe(5);
		expect(result.totalPullRequestContributions).toBe(2);
		expect(result.pullRequestContributions.nodes).toEqual([]);
	});

	test("passes login + window as variables", async () => {
		const graphql = jest.fn(
			async (_query: string, _variables?: Record<string, unknown>) =>
				mainResponse(),
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

	test("embeds the expected selection set in the main query", async () => {
		const graphql = jest.fn(
			async (_query: string, _variables?: Record<string, unknown>) =>
				mainResponse(),
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
		expect(query).toContain("pageInfo");
		expect(query).toContain("mergedAt");
		expect(query).toContain("closedAt");
	});
});

describe("fetchContributionsCollection -- pagination", () => {
	test("paginates pullRequestContributions until hasNextPage is false", async () => {
		const pr1 = {
			occurredAt: "2026-04-01T10:00:00Z",
			pullRequest: {
				number: 1,
				title: "A",
				merged: false,
				mergedAt: null,
				closedAt: null,
				repository: { nameWithOwner: "a/b" },
			},
		};
		const pr2 = {
			occurredAt: "2026-04-02T10:00:00Z",
			pullRequest: {
				number: 2,
				title: "B",
				merged: false,
				mergedAt: null,
				closedAt: null,
				repository: { nameWithOwner: "a/b" },
			},
		};

		const graphql = jest.fn(
			async (query: string, _variables?: Record<string, unknown>) => {
				if (query.includes("PaginatePullRequests")) {
					return {
						user: {
							contributionsCollection: {
								pullRequestContributions: {
									pageInfo: { endCursor: null, hasNextPage: false },
									nodes: [pr2],
								},
							},
						},
					};
				}
				return mainResponse({
					prs: {
						nodes: [pr1],
						hasNextPage: true,
						endCursor: "cursor-1",
					},
				});
			},
		);
		const client = mockClient(graphql);

		const result = await fetchContributionsCollection(
			client,
			"x",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
		);

		expect(result.pullRequestContributions.nodes).toHaveLength(2);
		expect(result.pullRequestContributions.nodes[0].pullRequest.number).toBe(1);
		expect(result.pullRequestContributions.nodes[1].pullRequest.number).toBe(2);
		expect(graphql).toHaveBeenCalledTimes(2);
	});

	test("paginates all three connections independently", async () => {
		const graphql = jest.fn(
			async (query: string, _variables?: Record<string, unknown>) => {
				if (query.includes("PaginatePullRequests")) {
					return {
						user: {
							contributionsCollection: {
								pullRequestContributions: {
									pageInfo: { endCursor: null, hasNextPage: false },
									nodes: [],
								},
							},
						},
					};
				}
				if (query.includes("PaginateIssues")) {
					return {
						user: {
							contributionsCollection: {
								issueContributions: {
									pageInfo: { endCursor: null, hasNextPage: false },
									nodes: [],
								},
							},
						},
					};
				}
				if (query.includes("PaginateReviews")) {
					return {
						user: {
							contributionsCollection: {
								pullRequestReviewContributions: {
									pageInfo: { endCursor: null, hasNextPage: false },
									nodes: [],
								},
							},
						},
					};
				}
				return mainResponse({
					prs: { nodes: [], hasNextPage: true, endCursor: "pr-1" },
					issues: { nodes: [], hasNextPage: true, endCursor: "i-1" },
					reviews: { nodes: [], hasNextPage: true, endCursor: "r-1" },
				});
			},
		);
		const client = mockClient(graphql);

		await fetchContributionsCollection(
			client,
			"x",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
		);

		// 1 main + 3 paginate calls
		expect(graphql).toHaveBeenCalledTimes(4);
	});

	test("warns when commitContributionsByRepository returns >=100 entries", async () => {
		const warnings: string[] = [];
		const bigList = Array.from({ length: 100 }, (_, i) => ({
			repository: { nameWithOwner: `a/${i}` },
			contributions: { nodes: [] },
		}));
		const client = mockClient(async () => mainResponse({ commitsByRepo: bigList }));

		await fetchContributionsCollection(
			client,
			"x",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
			{ onWarning: (m) => warnings.push(m) },
		);

		expect(warnings.some((m) => m.includes("commitContributionsByRepository"))).toBe(
			true,
		);
	});

	test("caps pagination at MAX_PAGES and surfaces a warning", async () => {
		const warnings: string[] = [];
		const graphql = jest.fn(
			async (query: string, _variables?: Record<string, unknown>) => {
				if (query.includes("PaginatePullRequests")) {
					// Always reports more pages -- runaway loop protection
					return {
						user: {
							contributionsCollection: {
								pullRequestContributions: {
									pageInfo: { endCursor: "next", hasNextPage: true },
									nodes: [],
								},
							},
						},
					};
				}
				return mainResponse({
					prs: { nodes: [], hasNextPage: true, endCursor: "start" },
				});
			},
		);
		const client = mockClient(graphql);

		await fetchContributionsCollection(
			client,
			"x",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
			{ onWarning: (m) => warnings.push(m) },
		);

		// 1 main + MAX_PAGES=10 paginate = 11 calls, then cap + warn.
		expect(graphql).toHaveBeenCalledTimes(11);
		expect(
			warnings.some((m) => m.includes("pullRequestContributions") && m.includes("cap")),
		).toBe(true);
	});

	test("does not warn when under truncation thresholds", async () => {
		const warnings: string[] = [];
		const smallList = Array.from({ length: 3 }, (_, i) => ({
			repository: { nameWithOwner: `a/${i}` },
			contributions: { nodes: [] },
		}));
		const client = mockClient(async () => mainResponse({ commitsByRepo: smallList }));

		await fetchContributionsCollection(
			client,
			"x",
			"2026-04-01T00:00:00Z",
			"2026-04-22T00:00:00Z",
			{ onWarning: (m) => warnings.push(m) },
		);

		expect(warnings).toHaveLength(0);
	});
});
