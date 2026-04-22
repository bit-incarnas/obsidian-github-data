import { RequestError } from "@octokit/request-error";

import type { GithubClient } from "../github/client";
import { InMemoryVaultWriter } from "../vault/writer";
import { syncRepoProfile } from "./repo-profile-writer";

interface FakeClient {
	client: GithubClient;
	getSpy: jest.Mock;
	getReadmeSpy: jest.Mock;
}

function makeClient(overrides: {
	getResponse?: () => unknown;
	getReadmeResponse?: () => unknown;
}): FakeClient {
	const getSpy = jest.fn(async () => {
		const resp = overrides.getResponse?.();
		if (typeof resp === "function") return (resp as () => unknown)();
		return resp;
	});
	const getReadmeSpy = jest.fn(async () => {
		if (!overrides.getReadmeResponse) {
			// Default: emulate "no README exists" so tests that don't care
			// about READMEs don't crash on undefined.
			throw new RequestError("Not Found", 404, {
				request: { method: "GET", url: "", headers: {} } as never,
			});
		}
		const resp = overrides.getReadmeResponse();
		if (typeof resp === "function") return (resp as () => unknown)();
		return resp;
	});
	const client = {
		rest: {
			repos: {
				get: getSpy,
				getReadme: getReadmeSpy,
			},
		},
	} as unknown as GithubClient;
	return { client, getSpy, getReadmeSpy };
}

function sampleRepoData(
	owner = "bit-incarnas",
	repo = "eden",
): Record<string, unknown> {
	return {
		id: 1,
		name: repo,
		full_name: `${owner}/${repo}`,
		owner: { login: owner, type: "User" },
		description: "Local-first AI sandbox.",
		html_url: `https://github.com/${owner}/${repo}`,
		homepage: null,
		language: "TypeScript",
		topics: ["obsidian", "llm"],
		visibility: "public",
		private: false,
		stargazers_count: 42,
		forks_count: 3,
		open_issues_count: 5,
		default_branch: "main",
		license: { spdx_id: "MIT" },
		created_at: "2026-02-15T12:00:00Z",
		pushed_at: "2026-04-21T08:00:00Z",
	};
}

function okResponse(data: unknown, status = 200) {
	return { data, status, headers: {}, url: "" };
}

const FIXED_NOW = new Date("2026-04-22T15:30:00Z");
const now = () => FIXED_NOW;

describe("syncRepoProfile", () => {
	test("writes the profile file with frontmatter + body", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			getResponse: () => okResponse(sampleRepoData()),
			getReadmeResponse: () => okResponse("# Eden\n\nA README body."),
		});

		const result = await syncRepoProfile("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.path).toBe(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/00_eden.md",
		);
		expect(result.syncedAt).toBe("2026-04-22T15:30:00.000Z");

		const stored = writer.files.get(result.path!);
		expect(stored).toBeDefined();
		expect(stored!.body).toContain("# bit-incarnas/eden");
		expect(stored!.body).toContain("> Local-first AI sandbox.");
		expect(stored!.body).toContain("## :: STATS");
		expect(stored!.body).toContain("| Stars | 42 |");
		expect(stored!.body).toContain("## :: README (fenced)");
		expect(stored!.body).toContain("````markdown");
		expect(stored!.body).toContain("# Eden");

		expect(stored!.frontmatter).toMatchObject({
			type: "github_repo",
			repo: "bit-incarnas/eden",
			owner: "bit-incarnas",
			name: "eden",
			language: "TypeScript",
			topics: ["obsidian", "llm"],
			stars: 42,
			forks: 3,
			open_issues_plus_prs: 5,
			default_branch: "main",
			license: "MIT",
			visibility: "public",
			last_synced: "2026-04-22T15:30:00.000Z",
			schema_version: 1,
			tags: ["github", "repo"],
		});
	});

	test("tolerates missing README (404) without failing", async () => {
		const writer = new InMemoryVaultWriter();
		const notFound = new RequestError("Not Found", 404, {
			request: { method: "GET", url: "", headers: {} } as never,
		});
		const { client } = makeClient({
			getResponse: () => okResponse(sampleRepoData()),
			getReadmeResponse: () => {
				throw notFound;
			},
		});

		const result = await syncRepoProfile("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		const stored = writer.files.get(result.path!);
		expect(stored!.body).not.toContain("## :: README");
	});

	test("fails closed when repo not in allowlist", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, getSpy } = makeClient({
			getResponse: () => okResponse(sampleRepoData()),
		});

		const result = await syncRepoProfile("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: [],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/allowlist/i);
		expect(writer.files.size).toBe(0);
		expect(getSpy).not.toHaveBeenCalled();
	});

	test("rejects malformed owner before any API call", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, getSpy } = makeClient({});

		const result = await syncRepoProfile("foo.bar", "repo", {
			client,
			writer,
			allowlist: ["foo.bar/repo"],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/owner/i);
		expect(getSpy).not.toHaveBeenCalled();
	});

	test("surfaces GitHub 403 as a structured error", async () => {
		const writer = new InMemoryVaultWriter();
		const err = new RequestError("Forbidden", 403, {
			request: { method: "GET", url: "", headers: {} } as never,
		});
		const { client } = makeClient({
			getResponse: () => {
				throw err;
			},
		});

		const result = await syncRepoProfile("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/403/);
		expect(writer.files.size).toBe(0);
	});

	test("overwrites existing file on re-sync", async () => {
		const writer = new InMemoryVaultWriter();
		const first = makeClient({
			getResponse: () => okResponse(sampleRepoData()),
		});
		const result1 = await syncRepoProfile("bit-incarnas", "eden", {
			client: first.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});
		expect(result1.ok).toBe(true);
		const initialBody = writer.files.get(result1.path!)!.body;

		const updated = { ...sampleRepoData(), stargazers_count: 1000 };
		const second = makeClient({
			getResponse: () => okResponse(updated),
		});
		const result2 = await syncRepoProfile("bit-incarnas", "eden", {
			client: second.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});
		expect(result2.ok).toBe(true);
		expect(result2.path).toBe(result1.path);

		const newBody = writer.files.get(result2.path!)!.body;
		expect(newBody).not.toBe(initialBody);
		expect(newBody).toContain("| Stars | 1000 |");
	});

	test("allowlist check is case-insensitive", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			getResponse: () => okResponse(sampleRepoData()),
		});

		const result = await syncRepoProfile("Bit-Incarnas", "Eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
	});

	test("ensures folders before writing file", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			getResponse: () => okResponse(sampleRepoData()),
		});

		await syncRepoProfile("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(writer.folders.has("02_AREAS/GitHub/Repos")).toBe(true);
		expect(
			writer.folders.has("02_AREAS/GitHub/Repos/bit-incarnas__eden"),
		).toBe(true);
	});
});
