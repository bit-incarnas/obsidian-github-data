# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (activity aggregator)
- **`src/github/graphql.ts`** — typed wrappers over `client.graphql()` for the two GraphQL queries we need: `fetchViewerLogin` (one-shot `{ viewer { login } }`) and `fetchContributionsCollection(login, from, to)` which returns commits-by-repo + opened PRs (with `merged` / `mergedAt` sub-shape) + opened issues (with `closedAt`) + reviews given. First use of GraphQL in the plugin; wires through Octokit's built-in `client.graphql()` so it benefits from the same auth + HTTP transport.
- **`src/sync/activity-writer.ts`** — `syncActivity(options)` fetches the user's contributionsCollection for the configured window, aggregates into per-day rollups via the pure `aggregateActivityByDay(data)` function, and writes one file per active day at `02_AREAS/GitHub/Activity/YYYY-MM/YYYY-MM-DD.md`.
- Aggregation rules: `commits_total` summed across repos on each UTC day; `prs_opened` / `issues_opened` / `reviews_given` counted on their `occurredAt` date; `prs_merged` derived from each PR's `mergedAt` (counted on merge date, not open date); `issues_closed` from each issue's `closedAt`. Per-repo breakdown captures commits / PRs-opened / issues-opened / reviews-given per repo.
- Frontmatter schema (`type: github_activity_day`, `schema_version: 1`): `date`, `commits_total`, `prs_opened`, `prs_merged`, `issues_opened`, `issues_closed`, `reviews_given`, `releases` (always 0 in this slice -- cross-ref to Releases/ or REST fan-out lands in a follow-up), `last_synced`, `tags: ["github", "activity"]`.
- Body: summary table, per-repo breakdown table (commits-desc ordered), `## :: YOUR NOTES` section with a `{% persist:user "notes" %}` block that survives re-sync via `extractPersistBlocks` + `mergePersistBlocks`.
- **`src/settings/types.ts`** — new `activitySyncDays: number` setting (default 30, max 365 to respect GitHub's contributionsCollection 1-year cap per query).
- **`src/settings/settings-tab.ts`** — new "Activity" section with a number input for the window; saves on change.
- **`src/main.ts`** — new command `GitHub Data: Sync activity`. Total commands: 7.
- Activity is user-centric, NOT filtered by repo allowlist -- the point is to capture the full contribution picture (the allowlist governs file-per-entity writes, which are repo-centric).
- **22 new tests across 2 suites** in `graphql.test.ts` (6) and `activity-writer.test.ts` (16) covering aggregation correctness, frontmatter emission, persist-block preservation on re-sync, viewer-login auto-resolution, GraphQL error paths, and window derivation. Total: **257 tests across 15 suites**.

### Data egress (activity aggregator)
- New egress: `POST /graphql` to `api.github.com`. Body = GraphQL query + variables (login, from, to ISO-8601 datetimes); never contains vault data. One request per `Sync activity` invocation; plus a preliminary `viewer { login }` query the first time per session (cached in the result for subsequent runs if the caller passes `login` back in).
- All existing call properties still hold: user-initiated, no telemetry, no third-party egress, PAT-only-in-Authorization-header.

### Added
- Initial repository scaffold: esbuild config, TypeScript config, Jest setup with obsidian mock shim, GitHub Actions CI (audit + gitleaks + typecheck + test + build), Dependabot config.
- `docs/data-egress.md` and `docs/data-schema.md` disclosure artifacts per the plugin program's data-egress policy.
- `NOTICES` file tracking future code-level lifts and their license provenance.
- Minimal `Plugin` stub with smoke test.
- Pre-push hook blocking direct pushes to `main`; `npm install` auto-wires `core.hooksPath`.
- **GitHub HTTP client** (`src/github/client.ts`) built on `@octokit/core` + plugin-paginate-rest + plugin-rest-endpoint-methods. Integrated via `octokit.hook.wrap("request", ...)` — no `request.fetch` swap, no Response-shape impedance.
- HTTP dependency is injectable (`HttpFn`) so integration tests can swap Obsidian's `requestUrl` for a Node-fetch adapter.
- Unit tests (`src/github/client.test.ts`) cover: success path, auth header, user-agent, 4xx→RequestError, `status === 0`→explicit throw, header normalization, pagination wiring.
- Integration tests (`tests/integration/auth.integration.test.ts`) hit real GitHub when `GH_TEST_TOKEN` is set; run via `npm run test:integration`.
- **Settings schema + SecretStorage wrappers** (`src/settings/`): types, defaults, merge helper; `isSecretStorageAvailable`, `getSecret`/`setSecret`/`clearSecret`, `resolveToken`, `migrateTokenToSecretStorage`.
- **Settings UI** (`src/settings/settings-tab.ts`): password-input token field with Save button, plaintext-storage warning banner, "Migrate to SecretStorage" CTA with explicit rotation warning, "Test connection" button (calls `GET /user`, surfaces rate-limit remaining + specific 401/403-SSO error messages), "Clear token" action.
- **Dev-vault `.git` notice** (`src/settings/dev-vault-notice.ts`): detects whether the vault path or any ancestor contains a `.git` directory; shows a one-time sticky Notice warning about data.json landing in git history; flag persisted in settings so it doesn't repeat.
- Mock shim (`__mocks__/obsidian.ts`) gained `FileSystemAdapter` class.
- Unit tests: 13 new (SecretStorage wrappers), 8 new (dev-vault notice), 4 expanded (main.ts). Total: **41 tests passing across 4 suites**.

### Data egress
- Plugin runtime now has **one** possible outbound call: `GET /user` to `api.github.com`, fired only when the user clicks "Test connection" in Settings. No background polls, no scheduled syncs, no auto-fetches.

### Added (path sanitation)
- **`src/paths/sanitize.ts`** — layered defenses against hostile GitHub-sourced path components (C1 from the pre-implementation security review). Covers: `sanitizePathSegment`, `slugifyTitle`, `composeRepoFolderName`, `issueFilename`, `validateRepoName`, `parseRepoPath`, `normalizePath`, `isPathInside`, `joinInsideRoot`.
- Defenses: NFKC normalization, ASCII whitelist (rejects Cyrillic/Greek homoglyphs), leading/trailing dot stripping, Windows reserved-name escaping (`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` with optional extensions), length caps, fallback-on-empty, lowercase-by-default for case-insensitive FS safety.
- `joinInsideRoot` performs normalization + containment check, rejecting `..`-based path escapes.
- **61 new tests** in `src/paths/sanitize.test.ts`. Total: **102 tests across 5 suites**.

### Added (repo allowlist)
- **`src/settings/allowlist.ts`** — pure add/remove/dedup helpers. Entries canonicalized as lowercase `owner/repo` (GitHub is case-insensitive for owner/repo, so storing a canonical form prevents silent duplicates).
- `addRepoToAllowlist` validates via `parseRepoPath`, dedups case-insensitively, returns a new array (immutable).
- `isRepoAllowlisted` for the codeblock processor + sync engine to enforce the allowlist at call time (Security Invariant H3).
- Settings UI gained a "Repositories" section: text input + Add button with validation feedback, list of current entries with per-row Remove buttons, empty-state hint.
- **19 new tests** in `src/settings/allowlist.test.ts`. Total: **121 tests across 6 suites**.

### Added (repo profile writer — first real sync)
- **`src/vault/writer.ts`** — `VaultWriter` interface + `ObsidianVaultWriter` (defensive folder creation with race handling; `writeFile` create-or-modify; `updateFrontmatter` routed through `app.fileManager.processFrontMatter`) + `InMemoryVaultWriter` for tests.
- **`src/sync/repo-profile-writer.ts`** — `syncRepoProfile(owner, repo, options)` fetches repo metadata + optional README, composes a contained vault path, writes body with a stats table, and sets frontmatter atomically via `processFrontMatter`. Allowlist-enforced and malformed-name-rejected before any API call.
- README content is **fenced as a code block** for v0.1 (Security Invariant L3) — full middle-ground body sanitizer arrives in a later slice.
- New command `GitHub Data: Sync all repo profiles` iterates the allowlist, updates `settings.lastSyncedAt` per entry, and surfaces a final ok/failed count via Notice.
- **8 new tests** in `src/sync/repo-profile-writer.test.ts`. Total: **129 tests across 7 suites**.

### Data egress (updated)
- Plugin runtime now has **three** possible outbound calls, all **user-initiated**: `GET /user` (Test connection), `GET /repos/{owner}/{repo}` and `GET /repos/{owner}/{repo}/readme` (Sync command, one iteration per allowlisted repo). No background polls, no scheduled syncs, no auto-fetches on startup. `docs/data-egress.md` updated.

### Added (middle-ground body sanitizer)
- **`src/sanitize/body.ts`** — `sanitizeGithubMarkdown(input)` composable sanitizer for every GitHub-sourced markdown body written into the vault. Implements Security Invariant H1 (middle-ground).
- Defenses: strips `<script>` / `<iframe>` / `<object>` / `<embed>` / `<link>` / `<style>` / `<meta>` / `<base>` tags; strips `on*` event-handler attributes; strips `javascript:` and `data:text/html` URL schemes; rewrites `<img>` to markdown image form; escapes Templater markers `<% ... %>` / `<%* ... %>`; escapes Dataview inline queries (`` `= `` and `` `$= ``); rewrites wikilinks containing `..`; escapes persist-block markers (`{% persist:* %}`).
- Repo profile writer now **unfences** README content and passes it through the sanitizer. L3 (README fenced) workaround removed.
- **43 new tests** in `src/sanitize/body.test.ts` — one or more per defense, plus a combined-attack test (Templater + img + script + persist all together) that asserts neutralization. Total: **172 tests across 8 suites**.

### Added (Dependabot alerts writer)
- **`src/sync/dependabot-writer.ts`** — `syncRepoDependabotAlerts(owner, repo, options)` fetches open Dependabot alerts via `paginate` (`listAlertsForRepo`), writes one file per alert at `02_AREAS/GitHub/Repos/{owner}__{repo}/Dependabot/{number}-{package}-{severity}.md`.
- Open alerts only in v0.1 (dismissed/fixed archival deferred).
- Per-alert frontmatter: `type`, `repo`, `number`, `state`, `package`, `ecosystem`, `severity`, `ghsa`, `cve` (from direct field or `identifiers` array), `summary`, `vulnerable_range`, `fixed_in`, `manifest_path`, `created`, `updated`, `dismissed_at`, `fixed_at`, `html_url`, `last_synced`, `schema_version`, `tags` (with `severity/{level}` for Dataview bucketing).
- Body: summary blockquote, DETAILS table (package/ecosystem/severity/state/GHSA/CVE/vulnerable range/fixed version/manifest), GitHub link, sanitized advisory description, references list, persist-block user notes, NAV.
- 404 (alerts disabled on the repo) tolerated as `skipped: "alerts-disabled"` so the command doesn't fail across mixed allowlists. 403 gets a scope-hint message.
- Empty-alert-list path skips folder creation to keep the tree clean.
- New command: `GitHub Data: Sync all open Dependabot alerts`. Total commands: 6.
- **11 new tests** in `src/sync/dependabot-writer.test.ts`. Total: **235 tests across 13 suites**.

### Docs
- **README rewritten**: exhaustive data-egress table, setup walkthrough (install via BRAT, PAT creation + SecretStorage migration with rotate warning, allowlist, test connection, run sync commands), expanded safety-posture section, development section covering integration-test invocation and pre-push hook / PR workflow.

### Added (release writer)
- **`src/sync/release-writer.ts`** — `syncRepoReleases(owner, repo, options)` fetches all releases via `paginate` (listReleases endpoint), writes one file per release at `02_AREAS/GitHub/Repos/{owner}__{repo}/Releases/{sanitized-tag}.md`.
- Tag names are run through `sanitizePathSegment` (tags can contain arbitrary characters, including `/`).
- Per-release frontmatter: `type`, `repo`, `tag`, `name`, `is_draft`, `is_prerelease`, `author`, `assets_count`, `created`, `published`, `html_url`, `last_synced`, `schema_version`, `tags` (with `draft` / `prerelease` markers added dynamically).
- Body: `# {tag} -- {name}`, state bits (draft / prerelease / author), published/created date, asset list with sizes formatted human-readably, GitHub link, sanitized release notes, persist-block user notes, NAV footer.
- Same defense layering as other writers: allowlist, path containment, body sanitizer, persist-block preservation.
- Empty-tag releases skipped (extremely rare but possible).
- New command: `GitHub Data: Sync all releases`. Total commands: 5.
- **10 new tests** in `src/sync/release-writer.test.ts`. Total: **224 tests across 12 suites**.

### Added (pull request writer)
- **`src/sync/pr-writer.ts`** — `syncRepoPullRequests(owner, repo, options)` fetches all open PRs via `paginate` (clean `pulls.list` shape, no `issues.listForRepo` + filter), writes one file per PR at `02_AREAS/GitHub/Repos/{owner}__{repo}/Pull_Requests/{number}-{slug}.md`.
- PR-specific frontmatter: `is_draft`, `base_branch`, `head_branch`, `requested_reviewers`, `merged_at`. Rest mirrors issue writer.
- Body includes branch indicator (`head -> base`), state + draft marker, labels / assignees / reviewers / milestone, GitHub link, sanitized description, persist-block user notes, NAV footer.
- Same defense layering as issue writer: allowlist + name validation + path containment + body sanitizer + persist-block preservation.
- New command: `GitHub Data: Sync all open pull requests`. Total commands: 4 (ping, sync profiles, sync issues, sync PRs).
- **9 new tests** in `src/sync/pr-writer.test.ts`. Total: **214 tests across 11 suites**.
- Deferred to future enrichment: `mergeable_state`, `review_decision` (GraphQL-only), review comments, CodeRabbit first-class treatment.

### Added (issue writer)
- **`src/sync/issue-writer.ts`** — `syncRepoIssues(owner, repo, options)` fetches all open issues via `paginate`, filters PRs out of the issues feed, writes one file per issue at `02_AREAS/GitHub/Repos/{owner}__{repo}/Issues/{number}-{slug}.md`.
- Per-issue frontmatter: `type`, `repo`, `number`, `state`, `title`, `labels`, `assignees`, `milestone`, `author`, `comments_count`, `created`, `updated`, `closed`, `html_url`, `last_synced`, `schema_version`, `tags`.
- Body: H1 with number + title, state/author meta, labels / assignees / milestone, GitHub link, sanitized issue body, persist-block user notes section, NAV footer.
- Re-sync preserves user persist blocks via the same `extractPersistBlocks` + `mergePersistBlocks` pattern as the repo profile writer.
- New command: `GitHub Data: Sync all open issues`.
- **10 new tests** in `src/sync/issue-writer.test.ts`. Total: **205 tests across 10 suites**.

### Added (persist-block utilities)
- **`src/sanitize/persist.ts`** — `extractPersistBlocks(text)`, `mergePersistBlocks(newText, saved)`, `looksGithubSourced(content)`, `userPersistBlock(name, initial?)`. Implements Security Invariant H2 defensively.
- Namespaced markers: `{% persist:user "name" %}...{% endpersist %}` survive re-sync; `{% persist:template "name" %}...{% endpersist %}` are transient and always replaced by the writer.
- Orphaned user blocks (saved name no longer in template) are preserved in a clearly-marked orphan section inserted before the `## :: NAV` footer rather than silently lost.
- Repo profile writer now includes a `## :: YOUR NOTES` section with a `persist:user "notes"` block by default, and preserves the user's content across re-syncs via `extractPersistBlocks` + `mergePersistBlocks`.
- NOTICES updated with pattern-level acknowledgement of `obsidian-zotero-integration` (original pattern) and `LonoxX/obsidian-github-issues` (refinement). No code copied -- logic re-derived with project-specific namespacing.
- **23 new tests** in `src/sanitize/persist.test.ts` + **2 new integration tests** in `repo-profile-writer.test.ts`. Total: **195 tests across 9 suites**.
