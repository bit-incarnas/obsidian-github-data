/**
 * Typed GraphQL helpers.
 *
 * Octokit clients expose a `graphql()` method out of the box (it's part
 * of `@octokit/core`). This module wraps the calls we care about with
 * strongly-typed response shapes so callers don't pass raw query strings
 * around.
 *
 * Current consumers:
 * - `fetchViewerLogin` -- one-shot `{ viewer { login } }` lookup, used to
 *   identify the authenticated user for contributionsCollection queries.
 * - `fetchContributionsCollection` -- the user's activity across repos
 *   for a time window, used by the activity aggregator to build daily
 *   rollup files. Returns commits-by-repo + opened PRs + opened issues
 *   + given reviews with occurredAt timestamps and sub-shapes sufficient
 *   to derive "prs_merged" / "issues_closed" on the actual merge/close
 *   dates rather than the opened-at date.
 *
 * Date windows:
 * - GraphQL requires ISO-8601 DateTime for `from` / `to`.
 * - GitHub caps contributionsCollection to a 1-year window per query;
 *   callers must split longer ranges themselves. The aggregator's default
 *   window is 30 days so this is a future concern.
 *
 * Pagination:
 * - Commit contributions per repo and opened-PR/issue/review lists all
 *   use `first: 100`. For the default 30-day window that's a safe cap
 *   (a single repo rarely sees >100 commit-days or >100 opened PRs in a
 *   month). Longer windows or very active repos would need paging; we'll
 *   add it when cron/polling arrives and data volume demands it.
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

interface ContributionsEnvelope {
	user: { contributionsCollection: ContributionsCollection } | null;
}

// -- queries --------------------------------------------------------------

const VIEWER_QUERY = `query ViewerLogin { viewer { login } }`;

const CONTRIBUTIONS_QUERY = `
	query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
		user(login: $login) {
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
 * Fetch a user's contributionsCollection for an arbitrary [from, to]
 * window (ISO-8601 datetimes). Returns the parsed collection or throws
 * if the user isn't found / GraphQL errors.
 */
export async function fetchContributionsCollection(
	client: GithubClient,
	login: string,
	fromIso: string,
	toIso: string,
): Promise<ContributionsCollection> {
	const data = await client.graphql<ContributionsEnvelope>(
		CONTRIBUTIONS_QUERY,
		{ login, from: fromIso, to: toIso },
	);
	if (!data.user) {
		throw new Error(`User not found: ${login}`);
	}
	return data.user.contributionsCollection;
}
