import type { GithubClient } from "../github/client";
import { InMemoryVaultWriter } from "../vault/writer";
import { syncRepoReleases } from "./release-writer";

function makeClient(overrides: {
	releases?: unknown[];
	paginateError?: unknown;
}): { client: GithubClient; paginateSpy: jest.Mock } {
	const listRef = {};
	const paginateSpy = jest.fn(async () => {
		if (overrides.paginateError) throw overrides.paginateError;
		return overrides.releases ?? [];
	});
	const client = {
		paginate: paginateSpy,
		rest: {
			repos: {
				listReleases: listRef,
			},
		},
	} as unknown as GithubClient;
	return { client, paginateSpy };
}

function mkRelease(
	partial: Partial<Record<string, unknown>> & { tag_name: string },
) {
	return {
		tag_name: partial.tag_name,
		name: partial.name ?? `Release ${partial.tag_name}`,
		draft: partial.draft ?? false,
		prerelease: partial.prerelease ?? false,
		body: partial.body ?? "",
		html_url:
			partial.html_url ??
			`https://github.com/x/y/releases/tag/${partial.tag_name}`,
		author: partial.author ?? { login: "octocat" },
		assets: partial.assets ?? [],
		created_at: partial.created_at ?? "2026-04-10T00:00:00Z",
		published_at: partial.published_at ?? "2026-04-11T00:00:00Z",
	};
}

const FIXED_NOW = new Date("2026-04-22T15:30:00Z");
const now = () => FIXED_NOW;

describe("syncRepoReleases", () => {
	test("writes one file per release", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			releases: [
				mkRelease({ tag_name: "v1.0.0" }),
				mkRelease({ tag_name: "v1.1.0" }),
			],
		});

		const result = await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.syncedCount).toBe(2);
		const files = Array.from(writer.files.keys());
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Releases/v1.0.0.md",
		);
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Releases/v1.1.0.md",
		);
	});

	test("sanitizes exotic tag names for filesystem safety", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			releases: [mkRelease({ tag_name: "v1.0/slash" })],
		});

		await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const files = Array.from(writer.files.keys());
		// Slash replaced with dash by sanitizePathSegment
		expect(files[0]).toContain("v1.0-slash");
		expect(files[0]).not.toContain("v1.0/slash");
	});

	test("skips releases with empty tag_name", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			releases: [
				mkRelease({ tag_name: "v1.0.0" }),
				mkRelease({ tag_name: "" }),
			],
		});

		const result = await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.syncedCount).toBe(1);
		expect(result.failedCount).toBe(1);
	});

	test("sets release-specific frontmatter", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			releases: [
				mkRelease({
					tag_name: "v2.0.0",
					name: "v2.0.0 -- Big Bang",
					prerelease: true,
					assets: [
						{
							name: "bundle.zip",
							size: 10485760,
							browser_download_url: "https://example.com/bundle.zip",
						},
					],
				}),
			],
		});

		await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.frontmatter).toMatchObject({
			type: "github_release",
			repo: "bit-incarnas/eden",
			tag: "v2.0.0",
			name: "v2.0.0 -- Big Bang",
			is_draft: false,
			is_prerelease: true,
			author: "octocat",
			assets_count: 1,
			last_synced: "2026-04-22T15:30:00.000Z",
			schema_version: 1,
			tags: ["github", "release", "prerelease"],
		});
	});

	test("body includes assets table + prerelease marker", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			releases: [
				mkRelease({
					tag_name: "v0.1.0",
					prerelease: true,
					body: "## What's new\n\nSome notes.",
					assets: [
						{
							name: "main.js",
							size: 1024,
							browser_download_url: "https://example.com/main.js",
						},
					],
				}),
			],
		});

		await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body).toContain("prerelease");
		expect(entry.body).toContain("Assets (1)");
		expect(entry.body).toContain("main.js");
		expect(entry.body).toContain("1.0 KB");
		expect(entry.body).toContain("## :: NOTES");
		expect(entry.body).toContain("Some notes.");
	});

	test("body sanitizer applied to release notes", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			releases: [
				mkRelease({
					tag_name: "v1.0.0",
					body: "<script>alert(1)</script>\nlegit release notes",
				}),
			],
		});

		await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body.toLowerCase()).not.toContain("<script");
		expect(entry.body).toContain("legit release notes");
	});

	test("preserves persist blocks across re-sync", async () => {
		const writer = new InMemoryVaultWriter();
		const first = makeClient({
			releases: [mkRelease({ tag_name: "v1.0.0", name: "First cut" })],
		});
		await syncRepoReleases("bit-incarnas", "eden", {
			client: first.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const path =
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Releases/v1.0.0.md";
		const entry = writer.files.get(path)!;
		entry.body = entry.body.replace(
			/\{% persist:user "notes" %\}\n\n\{% endpersist %\}/,
			'{% persist:user "notes" %}\nDeployed 2026-04-11 to prod\n{% endpersist %}',
		);

		// Re-sync with updated release name.
		const second = makeClient({
			releases: [
				mkRelease({ tag_name: "v1.0.0", name: "First cut (stable)" }),
			],
		});
		await syncRepoReleases("bit-incarnas", "eden", {
			client: second.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const updated = writer.files.get(path)!;
		expect(updated.body).toContain("Deployed 2026-04-11 to prod");
		expect(updated.frontmatter.name).toBe("First cut (stable)");
	});

	test("fails closed when repo not in allowlist", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, paginateSpy } = makeClient({
			releases: [mkRelease({ tag_name: "v1.0.0" })],
		});

		const result = await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: [],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/allowlist/i);
		expect(paginateSpy).not.toHaveBeenCalled();
	});

	test("empty release list is a successful no-op", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({ releases: [] });

		const result = await syncRepoReleases("bit-incarnas", "eden", {
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

		const result = await syncRepoReleases("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/403/);
	});
});
