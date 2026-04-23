import {
	aggregateActivityByDay,
	buildActivityBody,
	syncActivity,
	type SyncActivityOptions,
} from "./activity-writer";
import type { ContributionsCollection } from "../github/graphql";
import type { GithubClient } from "../github/client";
import { InMemoryVaultWriter } from "../vault/writer";

function emptyCollection(): ContributionsCollection {
	return {
		totalCommitContributions: 0,
		totalIssueContributions: 0,
		totalPullRequestContributions: 0,
		totalPullRequestReviewContributions: 0,
		commitContributionsByRepository: [],
		pullRequestContributions: { nodes: [] },
		issueContributions: { nodes: [] },
		pullRequestReviewContributions: { nodes: [] },
	};
}

function mockClient(
	graphqlImpl: (
		query: string,
		variables?: Record<string, unknown>,
	) => Promise<unknown>,
): GithubClient {
	return { graphql: graphqlImpl } as unknown as GithubClient;
}

describe("aggregateActivityByDay", () => {
	test("empty input produces empty map", () => {
		const out = aggregateActivityByDay(emptyCollection());
		expect(out.size).toBe(0);
	});

	test("sums commit counts across repos on the same day", () => {
		const data = emptyCollection();
		data.commitContributionsByRepository = [
			{
				repository: { nameWithOwner: "a/b" },
				contributions: {
					nodes: [{ occurredAt: "2026-04-20T10:00:00Z", commitCount: 3 }],
				},
			},
			{
				repository: { nameWithOwner: "c/d" },
				contributions: {
					nodes: [{ occurredAt: "2026-04-20T12:00:00Z", commitCount: 5 }],
				},
			},
		];

		const out = aggregateActivityByDay(data);
		expect(out.size).toBe(1);
		const day = out.get("2026-04-20");
		expect(day?.commits_total).toBe(8);
		expect(day?.per_repo.get("a/b")?.commits).toBe(3);
		expect(day?.per_repo.get("c/d")?.commits).toBe(5);
	});

	test("separates commits on different UTC dates even within a single repo", () => {
		const data = emptyCollection();
		data.commitContributionsByRepository = [
			{
				repository: { nameWithOwner: "a/b" },
				contributions: {
					nodes: [
						{ occurredAt: "2026-04-20T23:59:00Z", commitCount: 2 },
						{ occurredAt: "2026-04-21T00:01:00Z", commitCount: 1 },
					],
				},
			},
		];

		const out = aggregateActivityByDay(data);
		expect(out.get("2026-04-20")?.commits_total).toBe(2);
		expect(out.get("2026-04-21")?.commits_total).toBe(1);
	});

	test("counts prs_opened on occurredAt and prs_merged on mergedAt", () => {
		const data = emptyCollection();
		data.pullRequestContributions.nodes = [
			{
				occurredAt: "2026-04-19T08:00:00Z",
				pullRequest: {
					number: 42,
					title: "x",
					merged: true,
					mergedAt: "2026-04-21T14:00:00Z",
					closedAt: null,
					repository: { nameWithOwner: "a/b" },
				},
			},
			{
				occurredAt: "2026-04-19T09:00:00Z",
				pullRequest: {
					number: 43,
					title: "y",
					merged: false,
					mergedAt: null,
					closedAt: null,
					repository: { nameWithOwner: "a/b" },
				},
			},
		];

		const out = aggregateActivityByDay(data);
		expect(out.get("2026-04-19")?.prs_opened).toBe(2);
		expect(out.get("2026-04-19")?.prs_merged).toBe(0);
		expect(out.get("2026-04-21")?.prs_merged).toBe(1);
		expect(out.get("2026-04-21")?.prs_opened ?? 0).toBe(0);
	});

	test("counts issues_opened on occurredAt and issues_closed on closedAt", () => {
		const data = emptyCollection();
		data.issueContributions.nodes = [
			{
				occurredAt: "2026-04-10T10:00:00Z",
				issue: {
					number: 1,
					title: "bug",
					closedAt: "2026-04-12T09:00:00Z",
					repository: { nameWithOwner: "a/b" },
				},
			},
			{
				occurredAt: "2026-04-10T11:00:00Z",
				issue: {
					number: 2,
					title: "feat",
					closedAt: null,
					repository: { nameWithOwner: "a/b" },
				},
			},
		];

		const out = aggregateActivityByDay(data);
		expect(out.get("2026-04-10")?.issues_opened).toBe(2);
		expect(out.get("2026-04-10")?.issues_closed).toBe(0);
		expect(out.get("2026-04-12")?.issues_closed).toBe(1);
	});

	test("counts reviews_given", () => {
		const data = emptyCollection();
		data.pullRequestReviewContributions.nodes = [
			{
				occurredAt: "2026-04-15T12:00:00Z",
				pullRequest: { number: 7, repository: { nameWithOwner: "a/b" } },
			},
			{
				occurredAt: "2026-04-15T13:00:00Z",
				pullRequest: { number: 8, repository: { nameWithOwner: "c/d" } },
			},
		];

		const out = aggregateActivityByDay(data);
		const day = out.get("2026-04-15");
		expect(day?.reviews_given).toBe(2);
		expect(day?.per_repo.get("a/b")?.reviews).toBe(1);
		expect(day?.per_repo.get("c/d")?.reviews).toBe(1);
	});

	test("per-repo breakdown accumulates across all contribution types", () => {
		const data = emptyCollection();
		data.commitContributionsByRepository = [
			{
				repository: { nameWithOwner: "a/b" },
				contributions: {
					nodes: [{ occurredAt: "2026-04-20T10:00:00Z", commitCount: 5 }],
				},
			},
		];
		data.pullRequestContributions.nodes = [
			{
				occurredAt: "2026-04-20T10:00:00Z",
				pullRequest: {
					number: 1,
					title: "x",
					merged: false,
					mergedAt: null,
					closedAt: null,
					repository: { nameWithOwner: "a/b" },
				},
			},
		];
		data.issueContributions.nodes = [
			{
				occurredAt: "2026-04-20T10:00:00Z",
				issue: {
					number: 2,
					title: "y",
					closedAt: null,
					repository: { nameWithOwner: "a/b" },
				},
			},
		];
		data.pullRequestReviewContributions.nodes = [
			{
				occurredAt: "2026-04-20T10:00:00Z",
				pullRequest: { number: 3, repository: { nameWithOwner: "a/b" } },
			},
		];

		const out = aggregateActivityByDay(data);
		const day = out.get("2026-04-20");
		const repo = day?.per_repo.get("a/b");
		expect(repo).toEqual({
			commits: 5,
			prs_opened: 1,
			issues_opened: 1,
			reviews: 1,
		});
	});
});

describe("buildActivityBody", () => {
	test("includes summary table with all counters", () => {
		const day = {
			date: "2026-04-20",
			commits_total: 3,
			prs_opened: 1,
			prs_merged: 0,
			issues_opened: 2,
			issues_closed: 1,
			reviews_given: 4,
			releases: 0,
			per_repo: new Map(),
		};
		const body = buildActivityBody(day);
		expect(body).toContain("# Activity -- 2026-04-20");
		expect(body).toContain("| Commits | 3 |");
		expect(body).toContain("| PRs opened | 1 |");
		expect(body).toContain("| PRs merged | 0 |");
		expect(body).toContain("| Issues opened | 2 |");
		expect(body).toContain("| Issues closed | 1 |");
		expect(body).toContain("| Reviews given | 4 |");
	});

	test("renders per-repo breakdown table when repos exist", () => {
		const day = {
			date: "2026-04-20",
			commits_total: 8,
			prs_opened: 0,
			prs_merged: 0,
			issues_opened: 0,
			issues_closed: 0,
			reviews_given: 0,
			releases: 0,
			per_repo: new Map([
				["a/b", { commits: 5, prs_opened: 0, issues_opened: 0, reviews: 0 }],
				["c/d", { commits: 3, prs_opened: 0, issues_opened: 0, reviews: 0 }],
			]),
		};
		const body = buildActivityBody(day);
		expect(body).toContain("## :: PER-REPO BREAKDOWN");
		// Higher-commit repo sorts first.
		const aPos = body.indexOf("| a/b |");
		const cPos = body.indexOf("| c/d |");
		expect(aPos).toBeGreaterThan(0);
		expect(cPos).toBeGreaterThan(aPos);
	});

	test("omits per-repo section when no repos contributed", () => {
		const day = {
			date: "2026-04-20",
			commits_total: 0,
			prs_opened: 0,
			prs_merged: 0,
			issues_opened: 0,
			issues_closed: 0,
			reviews_given: 0,
			releases: 0,
			per_repo: new Map(),
		};
		const body = buildActivityBody(day);
		expect(body).not.toContain("PER-REPO BREAKDOWN");
	});

	test("includes a YOUR NOTES persist block", () => {
		const day = {
			date: "2026-04-20",
			commits_total: 0,
			prs_opened: 0,
			prs_merged: 0,
			issues_opened: 0,
			issues_closed: 0,
			reviews_given: 0,
			releases: 0,
			per_repo: new Map(),
		};
		const body = buildActivityBody(day);
		expect(body).toContain("## :: YOUR NOTES");
		expect(body).toContain('{% persist:user "notes" %}');
		expect(body).toContain("{% endpersist %}");
	});
});

describe("syncActivity", () => {
	const FIXED_NOW = new Date("2026-04-22T12:00:00Z");

	function baseOptions(
		writer: InMemoryVaultWriter,
		client: GithubClient,
		overrides: Partial<SyncActivityOptions> = {},
	): SyncActivityOptions {
		return {
			client,
			writer,
			now: () => FIXED_NOW,
			windowDays: 30,
			login: "bit-incarnas",
			...overrides,
		};
	}

	test("writes one file per active day", async () => {
		const writer = new InMemoryVaultWriter();
		const data = emptyCollection();
		data.commitContributionsByRepository = [
			{
				repository: { nameWithOwner: "bit-incarnas/eden" },
				contributions: {
					nodes: [
						{ occurredAt: "2026-04-19T10:00:00Z", commitCount: 2 },
						{ occurredAt: "2026-04-20T10:00:00Z", commitCount: 3 },
					],
				},
			},
		];
		const client = mockClient(async () => ({
			user: { contributionsCollection: data },
		}));

		const result = await syncActivity(baseOptions(writer, client));

		expect(result.ok).toBe(true);
		expect(result.totalDays).toBe(2);
		expect(result.writtenCount).toBe(2);
		expect(result.failedCount).toBe(0);
		expect(
			writer.files.has(
				"02_AREAS/GitHub/Activity/2026-04/2026-04-19.md",
			),
		).toBe(true);
		expect(
			writer.files.has(
				"02_AREAS/GitHub/Activity/2026-04/2026-04-20.md",
			),
		).toBe(true);
	});

	test("frontmatter carries the correct schema fields", async () => {
		const writer = new InMemoryVaultWriter();
		const data = emptyCollection();
		data.commitContributionsByRepository = [
			{
				repository: { nameWithOwner: "a/b" },
				contributions: {
					nodes: [{ occurredAt: "2026-04-20T10:00:00Z", commitCount: 7 }],
				},
			},
		];
		const client = mockClient(async () => ({
			user: { contributionsCollection: data },
		}));

		await syncActivity(baseOptions(writer, client));

		const file = writer.files.get(
			"02_AREAS/GitHub/Activity/2026-04/2026-04-20.md",
		);
		const fm = file?.frontmatter ?? {};
		expect(fm.type).toBe("github_activity_day");
		expect(fm.date).toBe("2026-04-20");
		expect(fm.commits_total).toBe(7);
		expect(fm.prs_opened).toBe(0);
		expect(fm.schema_version).toBe(1);
		expect(fm.tags).toEqual(["github", "activity"]);
		expect(fm.last_synced).toBe(FIXED_NOW.toISOString());
	});

	test("re-sync preserves user persist blocks", async () => {
		const writer = new InMemoryVaultWriter();
		const data = emptyCollection();
		data.commitContributionsByRepository = [
			{
				repository: { nameWithOwner: "a/b" },
				contributions: {
					nodes: [{ occurredAt: "2026-04-20T10:00:00Z", commitCount: 3 }],
				},
			},
		];
		const client = mockClient(async () => ({
			user: { contributionsCollection: data },
		}));

		// First sync
		await syncActivity(baseOptions(writer, client));

		// User edits their persist block
		const path = "02_AREAS/GitHub/Activity/2026-04/2026-04-20.md";
		const existing = writer.files.get(path)!;
		writer.files.set(path, {
			frontmatter: existing.frontmatter,
			body: existing.body.replace(
				/\{% persist:user "notes" %\}[\s\S]*?\{% endpersist %\}/,
				'{% persist:user "notes" %}\nThis is my diary entry about the day.\n{% endpersist %}',
			),
		});

		// Second sync (commit count bumped)
		data.commitContributionsByRepository[0].contributions.nodes[0].commitCount =
			5;
		await syncActivity(baseOptions(writer, client));

		const updated = writer.files.get(path);
		expect(updated?.body).toContain("This is my diary entry about the day.");
		// Fresh data landed too
		expect(updated?.body).toContain("| Commits | 5 |");
	});

	test("fetches viewer login when not supplied", async () => {
		const writer = new InMemoryVaultWriter();
		const graphql = jest.fn(async (query: string) => {
			if (query.includes("ViewerLogin")) {
				return { viewer: { login: "auto-resolved" } };
			}
			return { user: { contributionsCollection: emptyCollection() } };
		});
		const client = mockClient(graphql);

		const result = await syncActivity({
			client,
			writer,
			now: () => FIXED_NOW,
		});

		expect(result.login).toBe("auto-resolved");
		// Two calls: viewer lookup + contributionsCollection
		expect(graphql).toHaveBeenCalledTimes(2);
	});

	test("returns error when GraphQL viewer lookup fails", async () => {
		const writer = new InMemoryVaultWriter();
		const client = mockClient(async (query: string) => {
			if (query.includes("ViewerLogin")) {
				throw new Error("Bad credentials");
			}
			return {};
		});

		const result = await syncActivity({
			client,
			writer,
			now: () => FIXED_NOW,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("viewer login");
		expect(result.reason).toContain("Bad credentials");
	});

	test("returns error when contributionsCollection fetch fails", async () => {
		const writer = new InMemoryVaultWriter();
		const client = mockClient(async () => {
			throw new Error("rate limited");
		});

		const result = await syncActivity({
			client,
			writer,
			login: "bit-incarnas",
			now: () => FIXED_NOW,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("contributionsCollection");
		expect(result.reason).toContain("rate limited");
	});

	test("window derived from windowDays (default 30)", async () => {
		const writer = new InMemoryVaultWriter();
		const graphql = jest.fn(
			async (_query: string, _variables?: Record<string, unknown>) => ({
				user: { contributionsCollection: emptyCollection() },
			}),
		);
		const client = mockClient(graphql);

		await syncActivity(baseOptions(writer, client, { windowDays: 7 }));

		const callVars = graphql.mock.calls[0][1] as Record<string, string>;
		const fromDate = new Date(callVars.from);
		const toDate = new Date(callVars.to);
		const diffDays = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
		expect(diffDays).toBeCloseTo(7, 1);
		expect(toDate.toISOString()).toBe(FIXED_NOW.toISOString());
	});

	test("writes into correct YYYY-MM subfolder", async () => {
		const writer = new InMemoryVaultWriter();
		const data = emptyCollection();
		data.commitContributionsByRepository = [
			{
				repository: { nameWithOwner: "a/b" },
				contributions: {
					nodes: [{ occurredAt: "2026-03-15T10:00:00Z", commitCount: 1 }],
				},
			},
		];
		const client = mockClient(async () => ({
			user: { contributionsCollection: data },
		}));

		await syncActivity(baseOptions(writer, client));

		expect(
			writer.files.has(
				"02_AREAS/GitHub/Activity/2026-03/2026-03-15.md",
			),
		).toBe(true);
	});
});
