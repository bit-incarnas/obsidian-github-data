/**
 * Typed GraphQL helpers.
 *
 * Octokit clients expose a `graphql()` method out of the box (it's part
 * of `@octokit/core`). This module wraps the calls we care about with
 * strongly-typed response shapes so callers don't pass raw query strings
 * around.
 *
 * Current consumers:
 * - `fetchViewerLogin` -- one-shot `{ viewer { login } }` lookup, used
 *   for diagnostics + as the resolved login surfaced in `SyncActivityResult`.
 * - `fetchContributionsCollection` -- the authenticated user's activity
 *   across repos for a time window, used by the activity aggregator to
 *   build daily rollup files. Returns commits-by-repo + opened PRs +
 *   opened issues + given reviews with occurredAt timestamps and
 *   sub-shapes sufficient to derive "prs_merged" / "issues_closed" on
 *   the actual merge/close dates rather than the opened-at date.
 *
 * Why the `viewer` form (not `user(login: ...)`):
 * - `user(login: ...).contributionsCollection` is treated by GitHub as a
 *   third-party query and only returns what's visible on the user's
 *   public profile graph. Even with the "Include private contributions
 *   on profile" toggle ON, the per-repo / per-day breakdown for private
 *   contributions is omitted -- the API returns only anonymized public
 *   bucket counts. v0.0.4 used this form, which silently dropped every
 *   private commit out of the activity feed.
 * - `viewer.contributionsCollection` returns the authenticated user's
 *   complete contributions including granular private-repo data, which
 *   is what the activity aggregator actually needs.
 *
 * Date windows:
 * - GraphQL requires ISO-8601 DateTime for `from` / `to`.
 * - GitHub caps contributionsCollection to a 1-year window per query;
 *   callers must split longer ranges themselves. The aggregator's default
 *   window is 30 days so this is a future concern.
 *
 * Pagination:
 * - `pullRequestContributions`, `issueContributions`, and
 *   `pullRequestReviewContributions` use cursor paging (`after` +
 *   `pageInfo { endCursor hasNextPage }`). Each connection is paged
 *   until `hasNextPage` is false or the safety cap (`MAX_PAGES`) is hit.
 *   A cap warning surfaces via `onWarning` so the caller can log it.
 * - `commitContributionsByRepository` takes a single `maxRepositories`
 *   arg (GitHub's schema: not a cursored connection). Hard-capped at
 *   100. If a window has more than 100 contributing repos, we surface
 *   a truncation warning -- per-repo breakdown will be incomplete, but
 *   `commits_total` on the main contributionCalendar would still be
 *   correct if we queried it (we don't in v0.1; totals are summed from
 *   the breakdown). This limit is a future concern only for users with
 *   contributions to many different repos; Cap's solo-operator profile
 *   stays well under.
 * - Inner `contributions(first: 100)` per repo gives up to 100 days per
 *   repo. For 30-365-day windows that's sufficient (a single repo can't
 *   have more than `windowDays` distinct commit days). Unrestricted
 *   inner paging would add another nested loop; deferred.
 */

import type { GithubClient } from "./client";

// -- response shapes ------------------------------------------------------

export interface ViewerResponse {
	viewer: { login: string };
}

export interface ContributionsCollection {
	totalCommitContributions: number;
	totalIssueContributions: number;
	totalPullRequestContributions: number;
	totalPullRequestReviewContributions: number;
	commitContributionsByRepository: CommitContributionsByRepo[];
	pullRequestContributions: { nodes: PullRequestContribution[] };
	issueContributions: { nodes: IssueContribution[] };
	pullRequestReviewContributions: { nodes: ReviewContribution[] };
}

export interface CommitContributionsByRepo {
	repository: { nameWithOwner: string };
	contributions: { nodes: CommitContributionDay[] };
}

export interface CommitContributionDay {
	occurredAt: string; // ISO-8601 datetime; `.slice(0,10)` -> YYYY-MM-DD
	commitCount: number;
}

export interface PullRequestContribution {
	occurredAt: string;
	pullRequest: {
		number: number;
		title: string;
		merged: boolean;
		mergedAt: string | null;
		closedAt: string | null;
		repository: { nameWithOwner: string };
	};
}

export interface IssueContribution {
	occurredAt: string;
	issue: {
		number: number;
		title: string;
		closedAt: string | null;
		repository: { nameWithOwner: string };
	};
}

export interface ReviewContribution {
	occurredAt: string;
	pullRequest: {
		number: number;
		repository: { nameWithOwner: string };
	};
}

interface PageInfo {
	endCursor: string | null;
	hasNextPage: boolean;
}

interface MainQueryResponse {
	viewer: {
		contributionsCollection: {
			totalCommitContributions: number;
			totalIssueContributions: number;
			totalPullRequestContributions: number;
			totalPullRequestReviewContributions: number;
			commitContributionsByRepository: CommitContributionsByRepo[];
			pullRequestContributions: {
				pageInfo: PageInfo;
				nodes: PullRequestContribution[];
			};
			issueContributions: {
				pageInfo: PageInfo;
				nodes: IssueContribution[];
			};
			pullRequestReviewContributions: {
				pageInfo: PageInfo;
				nodes: ReviewContribution[];
			};
		};
	} | null;
}

interface PaginatePullRequestsResponse {
	viewer: {
		contributionsCollection: {
			pullRequestContributions: {
				pageInfo: PageInfo;
				nodes: PullRequestContribution[];
			};
		};
	} | null;
}

interface PaginateIssuesResponse {
	viewer: {
		contributionsCollection: {
			issueContributions: {
				pageInfo: PageInfo;
				nodes: IssueContribution[];
			};
		};
	} | null;
}

interface PaginateReviewsResponse {
	viewer: {
		contributionsCollection: {
			pullRequestReviewContributions: {
				pageInfo: PageInfo;
				nodes: ReviewContribution[];
			};
		};
	} | null;
}

/**
 * Safety cap on per-connection pagination. 100 nodes per page * 10
 * pages = 1000 contributions per type in a single window. A user who
 * legitimately exceeds this in 365 days is either (a) a maintainer of
 * a very active OSS project or (b) a bot account -- either way, the
 * rollup is sized for personal-activity tracking and we cap rather
 * than run unbounded loops.
 */
const MAX_PAGES = 10;

export interface FetchContributionsOptions {
	/** Called when we hit a truncation or cap condition. */
	onWarning?: (message: string) => void;
}

// -- queries --------------------------------------------------------------

const VIEWER_QUERY = `query ViewerLogin { viewer { login } }`;

const MAIN_CONTRIBUTIONS_QUERY = `
	query Contributions($from: DateTime!, $to: DateTime!) {
		viewer {
			contributionsCollection(from: $from, to: $to) {
				totalCommitContributions
				totalIssueContributions
				totalPullRequestContributions
				totalPullRequestReviewContributions
				commitContributionsByRepository(maxRepositories: 100) {
					repository { nameWithOwner }
					contributions(first: 100) {
						nodes {
							occurredAt
							commitCount
						}
					}
				}
				pullRequestContributions(first: 100) {
					pageInfo { endCursor hasNextPage }
					nodes {
						occurredAt
						pullRequest {
							number
							title
							merged
							mergedAt
							closedAt
							repository { nameWithOwner }
						}
					}
				}
				issueContributions(first: 100) {
					pageInfo { endCursor hasNextPage }
					nodes {
						occurredAt
						issue {
							number
							title
							closedAt
							repository { nameWithOwner }
						}
					}
				}
				pullRequestReviewContributions(first: 100) {
					pageInfo { endCursor hasNextPage }
					nodes {
						occurredAt
						pullRequest {
							number
							repository { nameWithOwner }
						}
					}
				}
			}
		}
	}
`;

const PAGINATE_PULL_REQUESTS_QUERY = `
	query PaginatePullRequests(
		$from: DateTime!
		$to: DateTime!
		$after: String!
	) {
		viewer {
			contributionsCollection(from: $from, to: $to) {
				pullRequestContributions(first: 100, after: $after) {
					pageInfo { endCursor hasNextPage }
					nodes {
						occurredAt
						pullRequest {
							number
							title
							merged
							mergedAt
							closedAt
							repository { nameWithOwner }
						}
					}
				}
			}
		}
	}
`;

const PAGINATE_ISSUES_QUERY = `
	query PaginateIssues(
		$from: DateTime!
		$to: DateTime!
		$after: String!
	) {
		viewer {
			contributionsCollection(from: $from, to: $to) {
				issueContributions(first: 100, after: $after) {
					pageInfo { endCursor hasNextPage }
					nodes {
						occurredAt
						issue {
							number
							title
							closedAt
							repository { nameWithOwner }
						}
					}
				}
			}
		}
	}
`;

const PAGINATE_REVIEWS_QUERY = `
	query PaginateReviews(
		$from: DateTime!
		$to: DateTime!
		$after: String!
	) {
		viewer {
			contributionsCollection(from: $from, to: $to) {
				pullRequestReviewContributions(first: 100, after: $after) {
					pageInfo { endCursor hasNextPage }
					nodes {
						occurredAt
						pullRequest {
							number
							repository { nameWithOwner }
						}
					}
				}
			}
		}
	}
`;

// -- helpers --------------------------------------------------------------

/** Returns the authenticated user's login. Throws on auth failure. */
export async function fetchViewerLogin(client: GithubClient): Promise<string> {
	const data = await client.graphql<ViewerResponse>(VIEWER_QUERY);
	return data.viewer.login;
}

/**
 * Fetch the authenticated viewer's contributionsCollection for an
 * arbitrary [from, to] window (ISO-8601 datetimes). Follows cursor
 * pagination on the three cursored connections until exhausted or until
 * `MAX_PAGES` is hit.
 *
 * Uses the `viewer` form, which returns granular private-repo
 * contributions in addition to public ones. The third-party
 * `user(login: ...)` form would silently drop private data even with
 * the profile-toggle on (see module header).
 *
 * Warnings:
 * - If `commitContributionsByRepository` comes back at exactly 100
 *   entries, it may be truncated (per-repo breakdown incomplete).
 * - If any cursored connection hits `MAX_PAGES`, that type's sample is
 *   truncated.
 */
export async function fetchContributionsCollection(
	client: GithubClient,
	fromIso: string,
	toIso: string,
	options: FetchContributionsOptions = {},
): Promise<ContributionsCollection> {
	const warn =
		options.onWarning ?? ((msg: string) => console.warn(`[graphql] ${msg}`));

	const main = await client.graphql<MainQueryResponse>(
		MAIN_CONTRIBUTIONS_QUERY,
		{ from: fromIso, to: toIso },
	);
	if (!main.viewer) {
		throw new Error(
			`Viewer contributions not returned (auth failure or unexpected response shape).`,
		);
	}
	const cc = main.viewer.contributionsCollection;

	const commitsByRepo = cc.commitContributionsByRepository;
	if (commitsByRepo.length >= 100) {
		warn(
			`commitContributionsByRepository returned ${commitsByRepo.length} repos (cap is 100); per-repo breakdown may be incomplete for this window.`,
		);
	}

	const prs = [...cc.pullRequestContributions.nodes];
	if (cc.pullRequestContributions.pageInfo.hasNextPage) {
		const rest = await paginatePullRequests(
			client,
			fromIso,
			toIso,
			cc.pullRequestContributions.pageInfo.endCursor ?? "",
			warn,
		);
		prs.push(...rest);
	}

	const issues = [...cc.issueContributions.nodes];
	if (cc.issueContributions.pageInfo.hasNextPage) {
		const rest = await paginateIssues(
			client,
			fromIso,
			toIso,
			cc.issueContributions.pageInfo.endCursor ?? "",
			warn,
		);
		issues.push(...rest);
	}

	const reviews = [...cc.pullRequestReviewContributions.nodes];
	if (cc.pullRequestReviewContributions.pageInfo.hasNextPage) {
		const rest = await paginateReviews(
			client,
			fromIso,
			toIso,
			cc.pullRequestReviewContributions.pageInfo.endCursor ?? "",
			warn,
		);
		reviews.push(...rest);
	}

	return {
		totalCommitContributions: cc.totalCommitContributions,
		totalIssueContributions: cc.totalIssueContributions,
		totalPullRequestContributions: cc.totalPullRequestContributions,
		totalPullRequestReviewContributions:
			cc.totalPullRequestReviewContributions,
		commitContributionsByRepository: commitsByRepo,
		pullRequestContributions: { nodes: prs },
		issueContributions: { nodes: issues },
		pullRequestReviewContributions: { nodes: reviews },
	};
}

async function paginatePullRequests(
	client: GithubClient,
	fromIso: string,
	toIso: string,
	firstCursor: string,
	warn: (msg: string) => void,
): Promise<PullRequestContribution[]> {
	const acc: PullRequestContribution[] = [];
	let cursor = firstCursor;
	let pages = 0;
	while (cursor) {
		if (pages >= MAX_PAGES) {
			warn(
				`pullRequestContributions hit ${MAX_PAGES}-page cap (${MAX_PAGES * 100} nodes); remaining PRs in this window are omitted.`,
			);
			break;
		}
		const data = await client.graphql<PaginatePullRequestsResponse>(
			PAGINATE_PULL_REQUESTS_QUERY,
			{ from: fromIso, to: toIso, after: cursor },
		);
		if (!data.viewer) break;
		const page = data.viewer.contributionsCollection.pullRequestContributions;
		acc.push(...page.nodes);
		cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? "") : "";
		pages += 1;
	}
	return acc;
}

async function paginateIssues(
	client: GithubClient,
	fromIso: string,
	toIso: string,
	firstCursor: string,
	warn: (msg: string) => void,
): Promise<IssueContribution[]> {
	const acc: IssueContribution[] = [];
	let cursor = firstCursor;
	let pages = 0;
	while (cursor) {
		if (pages >= MAX_PAGES) {
			warn(
				`issueContributions hit ${MAX_PAGES}-page cap (${MAX_PAGES * 100} nodes); remaining issues in this window are omitted.`,
			);
			break;
		}
		const data = await client.graphql<PaginateIssuesResponse>(
			PAGINATE_ISSUES_QUERY,
			{ from: fromIso, to: toIso, after: cursor },
		);
		if (!data.viewer) break;
		const page = data.viewer.contributionsCollection.issueContributions;
		acc.push(...page.nodes);
		cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? "") : "";
		pages += 1;
	}
	return acc;
}

async function paginateReviews(
	client: GithubClient,
	fromIso: string,
	toIso: string,
	firstCursor: string,
	warn: (msg: string) => void,
): Promise<ReviewContribution[]> {
	const acc: ReviewContribution[] = [];
	let cursor = firstCursor;
	let pages = 0;
	while (cursor) {
		if (pages >= MAX_PAGES) {
			warn(
				`pullRequestReviewContributions hit ${MAX_PAGES}-page cap (${MAX_PAGES * 100} nodes); remaining reviews in this window are omitted.`,
			);
			break;
		}
		const data = await client.graphql<PaginateReviewsResponse>(
			PAGINATE_REVIEWS_QUERY,
			{ from: fromIso, to: toIso, after: cursor },
		);
		if (!data.viewer) break;
		const page =
			data.viewer.contributionsCollection.pullRequestReviewContributions;
		acc.push(...page.nodes);
		cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? "") : "";
		pages += 1;
	}
	return acc;
}
