import { renderError, renderResultsTable } from "./renderer";
import type { EntityRecord } from "./query";

function newEl(): HTMLElement {
	return document.createElement("div");
}

describe("renderResultsTable -- empty state", () => {
	test("emits an empty-state div when no records", () => {
		const el = newEl();
		renderResultsTable(
			el,
			[],
			{ type: "github-issue" },
		);
		expect(el.querySelectorAll("table")).toHaveLength(0);
		const empty = el.querySelector(".github-data-empty");
		expect(empty).not.toBeNull();
		expect(empty!.textContent).toMatch(/github-issue/);
	});

	test("custom empty message", () => {
		const el = newEl();
		renderResultsTable(el, [], { type: "github-pr" }, { emptyMessage: "No PRs." });
		expect(el.querySelector(".github-data-empty")?.textContent).toBe("No PRs.");
	});
});

describe("renderResultsTable -- issue table", () => {
	const records: EntityRecord[] = [
		{
			path: "02_AREAS/GitHub/Repos/x__y/Issues/42-bug.md",
			frontmatter: {
				type: "github_issue",
				repo: "x/y",
				number: 42,
				title: "Bug in the frobnicator",
				labels: ["bug", "security"],
				author: "me",
				updated: "2026-04-22T10:00:00Z",
			},
		},
	];

	test("renders a table with default columns", () => {
		const el = newEl();
		renderResultsTable(el, records, { type: "github-issue" });

		const table = el.querySelector("table");
		expect(table).not.toBeNull();

		const headers = [...table!.querySelectorAll("thead th")].map(
			(th) => th.textContent ?? "",
		);
		// Defaults: file / number / title / labels / author / updated
		expect(headers).toEqual(["File", "#", "Title", "Labels", "Author", "Updated"]);
	});

	test("renders file cell as an internal-link anchor", () => {
		const el = newEl();
		renderResultsTable(el, records, { type: "github-issue" });
		const a = el.querySelector("tbody td:first-child a.internal-link");
		expect(a).not.toBeNull();
		expect(a!.getAttribute("data-href")).toBe(
			"02_AREAS/GitHub/Repos/x__y/Issues/42-bug.md",
		);
		expect(a!.textContent).toBe("42-bug");
	});

	test("internal-link anchor does NOT set target or rel (would break in-vault nav)", () => {
		const el = newEl();
		renderResultsTable(el, records, { type: "github-issue" });
		const a = el.querySelector("tbody td:first-child a.internal-link");
		expect(a!.getAttribute("target")).toBeNull();
		expect(a!.getAttribute("rel")).toBeNull();
	});

	test("renders labels as comma-separated string", () => {
		const el = newEl();
		renderResultsTable(el, records, { type: "github-issue" });
		const cells = [...el.querySelectorAll("tbody tr:first-child td")].map(
			(td) => td.textContent ?? "",
		);
		// Column order: file / number / title / labels / author / updated
		expect(cells[3]).toBe("bug, security");
	});

	test("honors `columns` override from args", () => {
		const el = newEl();
		renderResultsTable(el, records, {
			type: "github-issue",
			columns: ["number", "title"],
		});
		const headers = [...el.querySelectorAll("thead th")].map(
			(th) => th.textContent ?? "",
		);
		expect(headers).toEqual(["#", "Title"]);
	});

	test("honors `columns` override from options", () => {
		const el = newEl();
		renderResultsTable(
			el,
			records,
			{ type: "github-issue" },
			{ columns: ["title"] },
		);
		const headers = [...el.querySelectorAll("thead th")].map(
			(th) => th.textContent ?? "",
		);
		expect(headers).toEqual(["Title"]);
	});
});

describe("renderResultsTable -- cell types", () => {
	test("boolean cells render as yes/no", () => {
		const el = newEl();
		renderResultsTable(
			el,
			[
				{
					path: "a.md",
					frontmatter: {
						type: "github_pr",
						is_draft: true,
					},
				},
				{
					path: "b.md",
					frontmatter: {
						type: "github_pr",
						is_draft: false,
					},
				},
			],
			{ type: "github-pr", columns: ["is_draft"] },
		);
		const cells = [...el.querySelectorAll("tbody td")].map(
			(td) => td.textContent ?? "",
		);
		expect(cells).toEqual(["yes", "no"]);
	});

	test("html_url cell renders as external link", () => {
		const el = newEl();
		renderResultsTable(
			el,
			[
				{
					path: "a.md",
					frontmatter: {
						type: "github_issue",
						html_url: "https://github.com/x/y/issues/1",
					},
				},
			],
			{ type: "github-issue", columns: ["html_url"] },
		);
		const a = el.querySelector("tbody td a");
		expect(a).not.toBeNull();
		expect(a!.getAttribute("href")).toBe(
			"https://github.com/x/y/issues/1",
		);
		expect(a!.getAttribute("target")).toBe("_blank");
	});

	test("missing / null / undefined cells render as empty text", () => {
		const el = newEl();
		renderResultsTable(
			el,
			[
				{
					path: "a.md",
					frontmatter: {
						type: "github_issue",
						title: null,
						updated: undefined,
					},
				},
			],
			{
				type: "github-issue",
				columns: ["title", "updated", "author"],
			},
		);
		const cells = [...el.querySelectorAll("tbody td")].map(
			(td) => td.textContent ?? "",
		);
		expect(cells).toEqual(["", "", ""]);
	});
});

describe("renderError", () => {
	test("emits a warning tile with the provided message", () => {
		const el = newEl();
		renderError(el, "something broke");
		const warn = el.querySelector(".github-data-codeblock-error");
		expect(warn).not.toBeNull();
		expect(warn!.textContent).toContain("something broke");
	});
});
