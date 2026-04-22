import type { GithubClient } from "../github/client";
import { InMemoryVaultWriter } from "../vault/writer";
import { syncRepoIssues } from "./issue-writer";

interface FakeClient {
	client: GithubClient;
	paginateSpy: jest.Mock;
	listForRepoRef: unknown; // reference passed into paginate
}

function makeClient(overrides: {
	issues?: unknown[];
	paginateError?: unknown;
}): FakeClient {
	const listForRepoRef = {}; // opaque token; paginate only checks reference
	const paginateSpy = jest.fn(async (_ref: unknown, _params: unknown) => {
		if (overrides.paginateError) throw overrides.paginateError;
		return overrides.issues ?? [];
	});
	const client = {
		paginate: paginateSpy,
		rest: {
			issues: {
				listForRepo: listForRepoRef,
			},
		},
	} as unknown as GithubClient;
	return { client, paginateSpy, listForRepoRef };
}

function mkIssue(partial: Partial<Record<string, unknown>> & { number: number; title: string }) {
	return {
		number: partial.number,
		title: partial.title,
		state: partial.state ?? "open",
		body: partial.body ?? "",
		html_url: partial.html_url ?? `https://github.com/x/y/issues/${partial.number}`,
		user: partial.user ?? { login: "octocat" },
		labels: partial.labels ?? [],
		assignees: partial.assignees ?? [],
		milestone: partial.milestone ?? null,
		comments: partial.comments ?? 0,
		created_at: partial.created_at ?? "2026-04-01T00:00:00Z",
		updated_at: partial.updated_at ?? "2026-04-10T00:00:00Z",
		closed_at: partial.closed_at ?? null,
		pull_request: partial.pull_request,
	};
}

const FIXED_NOW = new Date("2026-04-22T15:30:00Z");
const now = () => FIXED_NOW;

describe("syncRepoIssues", () => {
	test("writes one file per open issue", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, paginateSpy } = makeClient({
			issues: [
				mkIssue({ number: 1, title: "First bug" }),
				mkIssue({ number: 42, title: "Fix login flow" }),
			],
		});

		const result = await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.syncedCount).toBe(2);
		expect(result.failedCount).toBe(0);
		expect(paginateSpy).toHaveBeenCalledTimes(1);

		const files = Array.from(writer.files.keys());
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Issues/1-first-bug.md",
		);
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Issues/42-fix-login-flow.md",
		);
	});

	test("filters out pull requests from the issues feed", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			issues: [
				mkIssue({ number: 1, title: "real issue" }),
				mkIssue({
					number: 2,
					title: "a PR",
					pull_request: { url: "x" },
				}),
			],
		});

		const result = await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.syncedCount).toBe(1);
		expect(writer.files.size).toBe(1);
	});

	test("sets frontmatter fields", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			issues: [
				mkIssue({
					number: 7,
					title: "Needs docs",
					labels: [{ name: "documentation" }, "good-first-issue"],
					assignees: [{ login: "alice" }, { login: "bob" }],
					milestone: { title: "v1.0" },
					comments: 3,
				}),
			],
		});

		await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.frontmatter).toMatchObject({
			type: "github_issue",
			repo: "bit-incarnas/eden",
			number: 7,
			state: "open",
			title: "Needs docs",
			labels: ["documentation", "good-first-issue"],
			assignees: ["alice", "bob"],
			milestone: "v1.0",
			author: "octocat",
			comments_count: 3,
			last_synced: "2026-04-22T15:30:00.000Z",
			schema_version: 1,
			tags: ["github", "issue", "open"],
		});
	});

	test("fails closed when repo not in allowlist", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, paginateSpy } = makeClient({
			issues: [mkIssue({ number: 1, title: "x" })],
		});

		const result = await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: [],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/allowlist/i);
		expect(paginateSpy).not.toHaveBeenCalled();
	});

	test("rejects malformed owner before any API call", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, paginateSpy } = makeClient({});

		const result = await syncRepoIssues("foo.bar", "repo", {
			client,
			writer,
			allowlist: ["foo.bar/repo"],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/owner/i);
		expect(paginateSpy).not.toHaveBeenCalled();
	});

	test("empty issue list is a successful no-op", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({ issues: [] });

		const result = await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.syncedCount).toBe(0);
		expect(writer.files.size).toBe(0);
	});

	test("body is sanitized (no raw <script>)", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			issues: [
				mkIssue({
					number: 99,
					title: "hostile",
					body: '<script>alert(1)</script>\nregular content',
				}),
			],
		});

		await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body.toLowerCase()).not.toContain("<script");
		expect(entry.body).toContain("regular content");
	});

	test("includes a YOUR NOTES persist block per issue", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			issues: [mkIssue({ number: 1, title: "hello" })],
		});

		await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body).toContain("## :: YOUR NOTES");
		expect(entry.body).toContain('{% persist:user "notes" %}');
	});

	test("preserves persist blocks across re-sync", async () => {
		const writer = new InMemoryVaultWriter();
		const firstClient = makeClient({
			issues: [mkIssue({ number: 1, title: "first" })],
		});

		await syncRepoIssues("bit-incarnas", "eden", {
			client: firstClient.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const path =
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Issues/1-first.md";
		const entry = writer.files.get(path)!;
		entry.body = entry.body.replace(
			/\{% persist:user "notes" %\}\n\n\{% endpersist %\}/,
			'{% persist:user "notes" %}\nMy note!\n{% endpersist %}',
		);

		const secondClient = makeClient({
			issues: [
				mkIssue({ number: 1, title: "first", comments: 5 }),
			],
		});
		await syncRepoIssues("bit-incarnas", "eden", {
			client: secondClient.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const updated = writer.files.get(path)!;
		expect(updated.body).toContain("My note!");
		expect(updated.frontmatter.comments_count).toBe(5);
	});

	test("surfaces GitHub 403 as a structured failure", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			paginateError: Object.assign(new Error("Forbidden"), {
				status: 403,
			}),
		});

		const result = await syncRepoIssues("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/403/);
		expect(writer.files.size).toBe(0);
	});
});
