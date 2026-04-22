import type { GithubClient } from "../github/client";
import { InMemoryVaultWriter } from "../vault/writer";
import { syncRepoPullRequests } from "./pr-writer";

function makeClient(overrides: {
	prs?: unknown[];
	paginateError?: unknown;
}): {
	client: GithubClient;
	paginateSpy: jest.Mock;
} {
	const listRef = {};
	const paginateSpy = jest.fn(async () => {
		if (overrides.paginateError) throw overrides.paginateError;
		return overrides.prs ?? [];
	});
	const client = {
		paginate: paginateSpy,
		rest: {
			pulls: {
				list: listRef,
			},
		},
	} as unknown as GithubClient;
	return { client, paginateSpy };
}

function mkPR(partial: Partial<Record<string, unknown>> & { number: number; title: string }) {
	return {
		number: partial.number,
		title: partial.title,
		state: partial.state ?? "open",
		draft: partial.draft ?? false,
		body: partial.body ?? "",
		html_url:
			partial.html_url ?? `https://github.com/x/y/pull/${partial.number}`,
		user: partial.user ?? { login: "octocat" },
		base: partial.base ?? { ref: "main" },
		head: partial.head ?? { ref: "feature/x" },
		labels: partial.labels ?? [],
		assignees: partial.assignees ?? [],
		requested_reviewers: partial.requested_reviewers ?? [],
		milestone: partial.milestone ?? null,
		created_at: partial.created_at ?? "2026-04-01T00:00:00Z",
		updated_at: partial.updated_at ?? "2026-04-10T00:00:00Z",
		closed_at: partial.closed_at ?? null,
		merged_at: partial.merged_at ?? null,
	};
}

const FIXED_NOW = new Date("2026-04-22T15:30:00Z");
const now = () => FIXED_NOW;

describe("syncRepoPullRequests", () => {
	test("writes one file per open PR", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			prs: [
				mkPR({ number: 17, title: "Add auth" }),
				mkPR({ number: 23, title: "Fix tests" }),
			],
		});

		const result = await syncRepoPullRequests("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.syncedCount).toBe(2);
		expect(result.failedCount).toBe(0);

		const files = Array.from(writer.files.keys());
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Pull_Requests/17-add-auth.md",
		);
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Pull_Requests/23-fix-tests.md",
		);
	});

	test("sets PR-specific frontmatter fields", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			prs: [
				mkPR({
					number: 42,
					title: "Draft: new feature",
					draft: true,
					base: { ref: "develop" },
					head: { ref: "feature/42" },
					labels: [{ name: "enhancement" }],
					assignees: [{ login: "alice" }],
					requested_reviewers: [{ login: "bob" }, { login: "eve" }],
				}),
			],
		});

		await syncRepoPullRequests("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.frontmatter).toMatchObject({
			type: "github_pr",
			repo: "bit-incarnas/eden",
			number: 42,
			state: "open",
			title: "Draft: new feature",
			is_draft: true,
			base_branch: "develop",
			head_branch: "feature/42",
			labels: ["enhancement"],
			assignees: ["alice"],
			requested_reviewers: ["bob", "eve"],
			tags: ["github", "pr", "open", "draft"],
		});
	});

	test("body includes branch indicator + state + draft marker", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			prs: [
				mkPR({
					number: 9,
					title: "Experimental",
					draft: true,
					base: { ref: "main" },
					head: { ref: "wip/xyz" },
				}),
			],
		});

		await syncRepoPullRequests("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body).toContain("PR #9 -- Experimental");
		expect(entry.body).toContain("(draft)");
		expect(entry.body).toContain("`wip/xyz` -> `main`");
	});

	test("fails closed when repo not in allowlist", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, paginateSpy } = makeClient({
			prs: [mkPR({ number: 1, title: "x" })],
		});

		const result = await syncRepoPullRequests("bit-incarnas", "eden", {
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

		const result = await syncRepoPullRequests("foo.bar", "repo", {
			client,
			writer,
			allowlist: ["foo.bar/repo"],
			now,
		});

		expect(result.ok).toBe(false);
		expect(paginateSpy).not.toHaveBeenCalled();
	});

	test("body is sanitized (no raw <script>)", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			prs: [
				mkPR({
					number: 99,
					title: "hostile PR",
					body: '<script>alert(1)</script>\nlegit content',
				}),
			],
		});

		await syncRepoPullRequests("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body.toLowerCase()).not.toContain("<script");
		expect(entry.body).toContain("legit content");
	});

	test("preserves persist blocks on re-sync", async () => {
		const writer = new InMemoryVaultWriter();
		const first = makeClient({
			prs: [mkPR({ number: 1, title: "first" })],
		});
		await syncRepoPullRequests("bit-incarnas", "eden", {
			client: first.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const path =
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Pull_Requests/1-first.md";
		const entry = writer.files.get(path)!;
		entry.body = entry.body.replace(
			/\{% persist:user "notes" %\}\n\n\{% endpersist %\}/,
			'{% persist:user "notes" %}\nREVIEW NOTE: ship it!\n{% endpersist %}',
		);

		const second = makeClient({
			prs: [
				mkPR({
					number: 1,
					title: "first",
					labels: [{ name: "ready" }],
				}),
			],
		});
		await syncRepoPullRequests("bit-incarnas", "eden", {
			client: second.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const updated = writer.files.get(path)!;
		expect(updated.body).toContain("REVIEW NOTE: ship it!");
		expect(updated.frontmatter.labels).toEqual(["ready"]);
	});

	test("empty PR list is a successful no-op", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({ prs: [] });

		const result = await syncRepoPullRequests("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.syncedCount).toBe(0);
		expect(writer.files.size).toBe(0);
	});

	test("surfaces GitHub 403 as a structured failure", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			paginateError: Object.assign(new Error("Forbidden"), {
				status: 403,
			}),
		});

		const result = await syncRepoPullRequests("bit-incarnas", "eden", {
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
