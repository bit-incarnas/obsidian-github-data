import {
	buildHydrationPlans,
	applyHydrationUpdates,
	HYDRATOR_INTERNALS_FOR_TESTS,
	REPOS_ROOT,
	type VaultFileSnapshot,
} from "./charter-hydrator";

const NOW = "2026-04-30T12:00:00.000Z";

function syncedFiles(opts: {
	owner: string;
	repo: string;
	profile?: Record<string, unknown> | null;
	issues?: number;
	prs?: number;
	dependabot?: number;
	releases?: Array<{ tag: string; publishedAt: string | null }>;
}): VaultFileSnapshot[] {
	const { owner, repo } = opts;
	const folder = `${REPOS_ROOT}/${owner}__${repo}`;
	const files: VaultFileSnapshot[] = [];

	files.push({
		path: `${folder}/00_${repo}.md`,
		frontmatter:
			opts.profile === null
				? null
				: {
						type: "github_repo",
						repo: `${owner}/${repo}`,
						default_branch: "main",
						last_synced: "2026-04-29T10:00:00.000Z",
						...(opts.profile ?? {}),
					},
	});

	for (let i = 0; i < (opts.issues ?? 0); i++) {
		files.push({
			path: `${folder}/Issues/${i + 1}-issue.md`,
			frontmatter: { number: i + 1 },
		});
	}
	for (let i = 0; i < (opts.prs ?? 0); i++) {
		files.push({
			path: `${folder}/Pull_Requests/${i + 1}-pr.md`,
			frontmatter: { number: i + 1 },
		});
	}
	for (let i = 0; i < (opts.dependabot ?? 0); i++) {
		files.push({
			path: `${folder}/Dependabot/${i + 1}-pkg-high.md`,
			frontmatter: { number: i + 1 },
		});
	}
	for (const r of opts.releases ?? []) {
		files.push({
			path: `${folder}/Releases/${r.tag}.md`,
			// release-writer writes the publish timestamp to `published`,
			// not `published_at`. Tests mirror that on-disk shape so a
			// regression to the wrong key is caught here.
			frontmatter: { tag: r.tag, published: r.publishedAt },
		});
	}

	return files;
}

describe("buildHydrationPlans -- opt-in marker handling", () => {
	test("files without github_repo are not in the result", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { project: "foo" },
				},
				...syncedFiles({ owner: "bit-incarnas", repo: "eden" }),
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans).toEqual([]);
	});

	test("file with github_repo: empty string -> skipped with reason", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { project: "foo", github_repo: "   " },
				},
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans).toHaveLength(1);
		expect(plans[0].status).toBe("skipped");
		expect(plans[0].reason).toMatch(/empty or non-string/);
	});

	test("file with github_repo: non-string -> skipped", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { project: "foo", github_repo: 42 },
				},
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans[0].status).toBe("skipped");
	});

	test("file with malformed github_repo (no slash) -> skipped with shape reason", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { github_repo: "not-a-repo-path" },
				},
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans).toHaveLength(1);
		expect(plans[0].status).toBe("skipped");
		expect(plans[0].reason).toMatch(/invalid github_repo marker/);
		expect(plans[0].reason).not.toMatch(/not in the allowlist/);
	});

	test("file with malformed github_repo (extra slash) -> skipped with shape reason", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { github_repo: "owner/repo/extra" },
				},
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans[0].status).toBe("skipped");
		expect(plans[0].reason).toMatch(/invalid github_repo marker/);
	});

	test("file with malformed github_repo (empty half) -> skipped with shape reason", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { github_repo: "owner/" },
				},
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans[0].status).toBe("skipped");
		expect(plans[0].reason).toMatch(/invalid github_repo marker/);
	});

	test("file with github_repo pointing at unallowlisted repo -> skipped", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { github_repo: "evil-org/exfil" },
				},
				...syncedFiles({ owner: "evil-org", repo: "exfil" }),
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans).toHaveLength(1);
		expect(plans[0].status).toBe("skipped");
		expect(plans[0].reason).toMatch(/not in the allowlist/);
	});

	test("file with github_repo but no synced data -> skipped", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { github_repo: "bit-incarnas/eden" },
				},
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(plans).toHaveLength(1);
		expect(plans[0].status).toBe("skipped");
		expect(plans[0].reason).toMatch(/no synced repo profile/);
	});
});

describe("buildHydrationPlans -- happy path", () => {
	test("opt-in charter with synced data gets a full hydration update", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/eden/00_CHARTER_eden.md",
					frontmatter: { project: "eden", github_repo: "bit-incarnas/eden" },
				},
				...syncedFiles({
					owner: "bit-incarnas",
					repo: "eden",
					issues: 3,
					prs: 2,
					dependabot: 1,
					releases: [
						{ tag: "v1.0.0", publishedAt: "2026-04-01T00:00:00Z" },
						{ tag: "v1.1.0", publishedAt: "2026-04-15T00:00:00Z" },
						{ tag: "v0.9.0", publishedAt: "2026-03-01T00:00:00Z" },
					],
				}),
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});

		expect(plans).toHaveLength(1);
		expect(plans[0].status).toBe("ok");
		expect(plans[0].updates).toEqual({
			gh_repo: "bit-incarnas/eden",
			gh_open_issues: 3,
			gh_open_prs: 2,
			gh_open_dependabot_alerts: 1,
			gh_last_release: "v1.1.0", // most recent published_at
			gh_default_branch: "main",
			gh_last_synced: "2026-04-29T10:00:00.000Z",
			gh_hydrated_at: NOW,
		});
	});

	test("zero entities and no releases produce zeros + null release", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/empty/00_CHARTER_empty.md",
					frontmatter: { github_repo: "bit-incarnas/quiet" },
				},
				...syncedFiles({ owner: "bit-incarnas", repo: "quiet" }),
			],
			allowlist: ["bit-incarnas/quiet"],
			nowIso: NOW,
		});

		expect(plans[0].status).toBe("ok");
		expect(plans[0].updates).toMatchObject({
			gh_open_issues: 0,
			gh_open_prs: 0,
			gh_open_dependabot_alerts: 0,
			gh_last_release: null,
		});
	});

	test("non-canonical github_repo (mixed case, whitespace) is canonicalized", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/eden/00_CHARTER_eden.md",
					frontmatter: { github_repo: "  Bit-Incarnas/Eden  " },
				},
				...syncedFiles({ owner: "bit-incarnas", repo: "eden" }),
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});

		expect(plans[0].status).toBe("ok");
		expect(plans[0].repoKey).toBe("bit-incarnas/eden");
		expect(plans[0].updates?.gh_repo).toBe("bit-incarnas/eden");
	});

	test("multiple charters can hydrate from the same repo independently", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/eden/00_CHARTER_eden.md",
					frontmatter: { github_repo: "bit-incarnas/eden" },
				},
				{
					path: "00_HUD/eden_console.md",
					frontmatter: { github_repo: "bit-incarnas/eden" },
				},
				...syncedFiles({
					owner: "bit-incarnas",
					repo: "eden",
					issues: 5,
				}),
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});

		expect(plans).toHaveLength(2);
		expect(plans.every((p) => p.status === "ok")).toBe(true);
		expect(plans[0].updates?.gh_open_issues).toBe(5);
		expect(plans[1].updates?.gh_open_issues).toBe(5);
	});

	test("multiple opt-in charters across multiple repos", () => {
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/eden/00_CHARTER_eden.md",
					frontmatter: { github_repo: "bit-incarnas/eden" },
				},
				{
					path: "03_PROJECTS/x/00_CHARTER_x.md",
					frontmatter: { github_repo: "bit-incarnas/x-mcp" },
				},
				...syncedFiles({ owner: "bit-incarnas", repo: "eden", prs: 7 }),
				...syncedFiles({ owner: "bit-incarnas", repo: "x-mcp", issues: 4 }),
			],
			allowlist: ["bit-incarnas/eden", "bit-incarnas/x-mcp"],
			nowIso: NOW,
		});

		const byRepo = Object.fromEntries(plans.map((p) => [p.repoKey, p]));
		expect(byRepo["bit-incarnas/eden"].updates?.gh_open_prs).toBe(7);
		expect(byRepo["bit-incarnas/x-mcp"].updates?.gh_open_issues).toBe(4);
	});
});

describe("buildHydrationPlans -- idempotency", () => {
	test("re-hydration with unchanged data is a no-op (status: skipped)", () => {
		const charterPath = "03_PROJECTS/eden/00_CHARTER_eden.md";
		const synced = syncedFiles({
			owner: "bit-incarnas",
			repo: "eden",
			issues: 3,
			prs: 2,
		});

		// First run -> compute the desired frontmatter
		const first = buildHydrationPlans({
			vaultFiles: [
				{
					path: charterPath,
					frontmatter: { github_repo: "bit-incarnas/eden" },
				},
				...synced,
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		expect(first[0].status).toBe("ok");
		const written = first[0].updates!;

		// Second run -> charter already has the data
		const second = buildHydrationPlans({
			vaultFiles: [
				{
					path: charterPath,
					frontmatter: { github_repo: "bit-incarnas/eden", ...written },
				},
				...synced,
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: "2026-05-01T08:00:00.000Z", // later "now"
		});

		expect(second[0].status).toBe("skipped");
		expect(second[0].reason).toMatch(/no change since last hydration/);
	});

	test("a single counter change triggers a write", () => {
		const charterPath = "03_PROJECTS/eden/00_CHARTER_eden.md";

		const baseline = buildHydrationPlans({
			vaultFiles: [
				{
					path: charterPath,
					frontmatter: { github_repo: "bit-incarnas/eden" },
				},
				...syncedFiles({ owner: "bit-incarnas", repo: "eden", issues: 3 }),
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: NOW,
		});
		const written = baseline[0].updates!;

		// One new issue lands -> count is now 4
		const updated = buildHydrationPlans({
			vaultFiles: [
				{
					path: charterPath,
					frontmatter: { github_repo: "bit-incarnas/eden", ...written },
				},
				...syncedFiles({ owner: "bit-incarnas", repo: "eden", issues: 4 }),
			],
			allowlist: ["bit-incarnas/eden"],
			nowIso: "2026-05-01T08:00:00.000Z",
		});

		expect(updated[0].status).toBe("ok");
		expect(updated[0].updates?.gh_open_issues).toBe(4);
		expect(updated[0].updates?.gh_hydrated_at).toBe("2026-05-01T08:00:00.000Z");
	});

	test("treats undefined-vs-null as equivalent on first hydration with empty source data", () => {
		// Charter has never been hydrated (no gh_* keys).
		// Source repo also has no releases / null fields.
		const plans = buildHydrationPlans({
			vaultFiles: [
				{
					path: "03_PROJECTS/foo/00_CHARTER_foo.md",
					frontmatter: { github_repo: "bit-incarnas/foo" },
				},
				...syncedFiles({
					owner: "bit-incarnas",
					repo: "foo",
					profile: { default_branch: "", last_synced: "" },
				}),
			],
			allowlist: ["bit-incarnas/foo"],
			nowIso: NOW,
		});

		// First hydration writes (counts go from undefined to 0 -- a real
		// change), so status is "ok" and updates carry the zeros.
		expect(plans[0].status).toBe("ok");
		expect(plans[0].updates?.gh_default_branch).toBeNull();
		expect(plans[0].updates?.gh_last_synced).toBeNull();
	});
});

describe("applyHydrationUpdates", () => {
	test("merges only the listed keys; preserves everything else", () => {
		const fm: Record<string, unknown> = {
			project: "eden",
			status: "active",
			github_repo: "bit-incarnas/eden",
			tags: ["project", "charter"],
			gh_open_issues: 1,
		};
		applyHydrationUpdates(fm, {
			gh_repo: "bit-incarnas/eden",
			gh_open_issues: 5,
			gh_open_prs: 2,
		});
		expect(fm).toEqual({
			project: "eden",
			status: "active",
			github_repo: "bit-incarnas/eden",
			tags: ["project", "charter"],
			gh_repo: "bit-incarnas/eden",
			gh_open_issues: 5,
			gh_open_prs: 2,
		});
	});
});

describe("internals -- pickLatestRelease", () => {
	const { pickLatestRelease } = HYDRATOR_INTERNALS_FOR_TESTS;

	test("empty list -> null", () => {
		expect(pickLatestRelease([])).toBeNull();
	});

	test("string-published wins over null-published", () => {
		const out = pickLatestRelease([
			{ tag: "v1.0.0", publishedAt: null },
			{ tag: "v0.5.0", publishedAt: "2026-01-01T00:00:00Z" },
		]);
		expect(out?.tag).toBe("v0.5.0");
	});

	test("most recent published_at wins; tag is tiebreaker", () => {
		const out = pickLatestRelease([
			{ tag: "v1.0.0", publishedAt: "2026-04-01T00:00:00Z" },
			{ tag: "v2.0.0", publishedAt: "2026-04-30T00:00:00Z" },
			{ tag: "v1.5.0", publishedAt: "2026-04-15T00:00:00Z" },
		]);
		expect(out?.tag).toBe("v2.0.0");
	});

	test("all-null publishedAt falls back to tag lexicographic order", () => {
		const out = pickLatestRelease([
			{ tag: "alpha", publishedAt: null },
			{ tag: "beta", publishedAt: null },
		]);
		expect(out?.tag).toBe("beta");
	});
});

describe("internals -- indexSyncedFilesByRepo", () => {
	const { indexSyncedFilesByRepo } = HYDRATOR_INTERNALS_FOR_TESTS;

	test("ignores files outside the repos root", () => {
		const idx = indexSyncedFilesByRepo([
			{
				path: "02_AREAS/Other/something.md",
				frontmatter: { type: "github_repo" },
			},
		]);
		expect(idx.size).toBe(0);
	});

	test("ignores malformed repo folder names (no double underscore split)", () => {
		const idx = indexSyncedFilesByRepo([
			{
				path: "02_AREAS/GitHub/Repos/badname/00_x.md",
				frontmatter: { type: "github_repo" },
			},
		]);
		expect(idx.size).toBe(0);
	});

	test("ignores profile files lacking type: github_repo", () => {
		const idx = indexSyncedFilesByRepo(
			syncedFiles({
				owner: "bit-incarnas",
				repo: "eden",
				profile: { type: "something_else" } as Record<string, unknown>,
			}),
		);
		const data = idx.get("bit-incarnas/eden");
		expect(data?.profile).toBeNull();
	});

	test("counts entities case-insensitively against folder names", () => {
		const idx = indexSyncedFilesByRepo([
			{
				path: "02_AREAS/GitHub/Repos/bit-incarnas__eden/Issues/1.md",
				frontmatter: null,
			},
			{
				path: "02_AREAS/GitHub/Repos/bit-incarnas__eden/PULL_REQUESTS/2.md",
				frontmatter: null,
			},
		]);
		const data = idx.get("bit-incarnas/eden");
		expect(data?.counts.issues).toBe(1);
		expect(data?.counts.prs).toBe(1);
	});
});
