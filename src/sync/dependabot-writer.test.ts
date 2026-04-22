import type { GithubClient } from "../github/client";
import { InMemoryVaultWriter } from "../vault/writer";
import { syncRepoDependabotAlerts } from "./dependabot-writer";

function makeClient(overrides: {
	alerts?: unknown[];
	paginateError?: unknown;
}): { client: GithubClient; paginateSpy: jest.Mock } {
	const listRef = {};
	const paginateSpy = jest.fn(async () => {
		if (overrides.paginateError) throw overrides.paginateError;
		return overrides.alerts ?? [];
	});
	const client = {
		paginate: paginateSpy,
		rest: {
			dependabot: {
				listAlertsForRepo: listRef,
			},
		},
	} as unknown as GithubClient;
	return { client, paginateSpy };
}

interface AlertShape {
	number: number;
	state?: string;
	dependency?: {
		package?: { name?: string; ecosystem?: string };
		manifest_path?: string;
	};
	security_advisory?: {
		ghsa_id?: string;
		cve_id?: string | null;
		severity?: string;
		summary?: string;
		description?: string;
		references?: { url?: string }[];
		identifiers?: { type: string; value: string }[];
	};
	security_vulnerability?: {
		severity?: string;
		vulnerable_version_range?: string;
		first_patched_version?: { identifier?: string };
	};
	html_url?: string;
	created_at?: string;
	updated_at?: string;
	dismissed_at?: string | null;
	fixed_at?: string | null;
}

function mkAlert(partial: AlertShape): AlertShape {
	return {
		number: partial.number,
		state: partial.state ?? "open",
		dependency: {
			package: {
				name: partial.dependency?.package?.name ?? "lodash",
				ecosystem: partial.dependency?.package?.ecosystem ?? "npm",
			},
			manifest_path:
				partial.dependency?.manifest_path ?? "package.json",
		},
		security_advisory: {
			ghsa_id: partial.security_advisory?.ghsa_id ?? "GHSA-xxxx",
			cve_id: partial.security_advisory?.cve_id ?? null,
			severity: partial.security_advisory?.severity ?? "high",
			summary:
				partial.security_advisory?.summary ?? "Prototype pollution.",
			description:
				partial.security_advisory?.description ?? "Long description.",
			references: partial.security_advisory?.references ?? [
				{ url: "https://example.com/ref" },
			],
			identifiers: partial.security_advisory?.identifiers ?? [
				{ type: "CVE", value: "CVE-2026-1234" },
				{ type: "GHSA", value: "GHSA-xxxx" },
			],
		},
		security_vulnerability: {
			severity: partial.security_vulnerability?.severity ?? "high",
			vulnerable_version_range:
				partial.security_vulnerability?.vulnerable_version_range ??
				"< 4.17.22",
			first_patched_version: {
				identifier:
					partial.security_vulnerability?.first_patched_version
						?.identifier ?? "4.17.22",
			},
		},
		html_url:
			partial.html_url ??
			`https://github.com/x/y/security/dependabot/${partial.number}`,
		created_at: partial.created_at ?? "2026-04-10T00:00:00Z",
		updated_at: partial.updated_at ?? "2026-04-12T00:00:00Z",
		dismissed_at: partial.dismissed_at ?? null,
		fixed_at: partial.fixed_at ?? null,
	};
}

const FIXED_NOW = new Date("2026-04-22T15:30:00Z");
const now = () => FIXED_NOW;

describe("syncRepoDependabotAlerts", () => {
	test("writes one file per open alert", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			alerts: [
				mkAlert({ number: 1 }),
				mkAlert({
					number: 2,
					dependency: { package: { name: "express" } },
				}),
			],
		});

		const result = await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.syncedCount).toBe(2);

		const files = Array.from(writer.files.keys());
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Dependabot/1-lodash-high.md",
		);
		expect(files).toContain(
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Dependabot/2-express-high.md",
		);
	});

	test("sets frontmatter with CVE + severity tag", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			alerts: [mkAlert({ number: 7 })],
		});

		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.frontmatter).toMatchObject({
			type: "github_dependabot_alert",
			repo: "bit-incarnas/eden",
			number: 7,
			state: "open",
			package: "lodash",
			ecosystem: "npm",
			severity: "high",
			ghsa: "GHSA-xxxx",
			cve: "CVE-2026-1234",
			vulnerable_range: "< 4.17.22",
			fixed_in: "4.17.22",
			tags: ["github", "dependabot", "security", "severity/high"],
		});
	});

	test("body includes DETAILS table + advisory description + references", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			alerts: [
				mkAlert({
					number: 3,
					security_advisory: {
						description: "Detailed advisory text.",
						severity: "critical",
						ghsa_id: "GHSA-abcd",
						summary: "RCE in foo",
						references: [
							{ url: "https://example.com/a" },
							{ url: "https://example.com/b" },
						],
						identifiers: [
							{ type: "CVE", value: "CVE-2026-9999" },
						],
					},
				}),
			],
		});

		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body).toContain("## :: DETAILS");
		expect(entry.body).toContain("Package");
		expect(entry.body).toContain("lodash");
		expect(entry.body).toContain("CVE-2026-9999");
		expect(entry.body).toContain("## :: ADVISORY DESCRIPTION");
		expect(entry.body).toContain("Detailed advisory text.");
		expect(entry.body).toContain("## :: REFERENCES");
		expect(entry.body).toContain("https://example.com/a");
		expect(entry.body).toContain("https://example.com/b");
	});

	test("404 means Dependabot alerts disabled -- skipped, not failed", async () => {
		const writer = new InMemoryVaultWriter();
		const notFound = Object.assign(new Error("Not Found"), { status: 404 });
		const { client } = makeClient({ paginateError: notFound });

		const result = await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.skipped).toBe("alerts-disabled");
		expect(writer.files.size).toBe(0);
	});

	test("403 carries a scope-hint message", async () => {
		const writer = new InMemoryVaultWriter();
		const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
		const { client } = makeClient({ paginateError: forbidden });

		const result = await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/Dependabot alerts: read/);
	});

	test("advisory description is sanitized", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			alerts: [
				mkAlert({
					number: 1,
					security_advisory: {
						description: "<script>alert('pwn')</script>safe text",
					},
				}),
			],
		});

		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.body.toLowerCase()).not.toContain("<script");
		expect(entry.body).toContain("safe text");
	});

	test("preserves persist blocks across re-sync", async () => {
		const writer = new InMemoryVaultWriter();
		const first = makeClient({
			alerts: [mkAlert({ number: 1 })],
		});
		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client: first.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const path =
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Dependabot/1-lodash-high.md";
		const entry = writer.files.get(path)!;
		entry.body = entry.body.replace(
			/\{% persist:user "notes" %\}\n\n\{% endpersist %\}/,
			'{% persist:user "notes" %}\nTriaged: will bump in next PR\n{% endpersist %}',
		);

		const second = makeClient({
			alerts: [
				mkAlert({
					number: 1,
					security_advisory: { severity: "critical" },
					security_vulnerability: { severity: "critical" },
				}),
			],
		});
		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client: second.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		// Severity changed from high -> critical; filename should change,
		// but the old file still has the persist block. Since the writer
		// doesn'\''t rename, a critical-variant file is now created alongside
		// and the user note on the old file survives as-is.
		const newPath =
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Dependabot/1-lodash-critical.md";
		expect(writer.files.has(newPath)).toBe(true);
	});

	test("preserves persist blocks when severity + filename unchanged", async () => {
		const writer = new InMemoryVaultWriter();
		const first = makeClient({
			alerts: [mkAlert({ number: 1 })],
		});
		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client: first.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const path =
			"02_AREAS/GitHub/Repos/bit-incarnas__eden/Dependabot/1-lodash-high.md";
		const entry = writer.files.get(path)!;
		entry.body = entry.body.replace(
			/\{% persist:user "notes" %\}\n\n\{% endpersist %\}/,
			'{% persist:user "notes" %}\nOur note\n{% endpersist %}',
		);

		const second = makeClient({
			alerts: [mkAlert({ number: 1 })],
		});
		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client: second.client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const updated = writer.files.get(path)!;
		expect(updated.body).toContain("Our note");
	});

	test("fails closed when repo not in allowlist", async () => {
		const writer = new InMemoryVaultWriter();
		const { client, paginateSpy } = makeClient({
			alerts: [mkAlert({ number: 1 })],
		});

		const result = await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: [],
			now,
		});

		expect(result.ok).toBe(false);
		expect(paginateSpy).not.toHaveBeenCalled();
	});

	test("empty alert list is a clean no-op; does not create folder", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({ alerts: [] });

		const result = await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		expect(result.ok).toBe(true);
		expect(result.syncedCount).toBe(0);
		expect(writer.files.size).toBe(0);
		expect(
			writer.folders.has(
				"02_AREAS/GitHub/Repos/bit-incarnas__eden/Dependabot",
			),
		).toBe(false);
	});

	test("handles cve_id on direct field (no identifiers array)", async () => {
		const writer = new InMemoryVaultWriter();
		const { client } = makeClient({
			alerts: [
				mkAlert({
					number: 1,
					security_advisory: {
						cve_id: "CVE-2026-0001",
						identifiers: [],
					},
				}),
			],
		});

		await syncRepoDependabotAlerts("bit-incarnas", "eden", {
			client,
			writer,
			allowlist: ["bit-incarnas/eden"],
			now,
		});

		const [entry] = Array.from(writer.files.values());
		expect(entry.frontmatter.cve).toBe("CVE-2026-0001");
	});
});
