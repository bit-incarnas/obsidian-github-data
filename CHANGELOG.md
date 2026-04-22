# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Added (persist-block utilities)
- **`src/sanitize/persist.ts`** — `extractPersistBlocks(text)`, `mergePersistBlocks(newText, saved)`, `looksGithubSourced(content)`, `userPersistBlock(name, initial?)`. Implements Security Invariant H2 defensively.
- Namespaced markers: `{% persist:user "name" %}...{% endpersist %}` survive re-sync; `{% persist:template "name" %}...{% endpersist %}` are transient and always replaced by the writer.
- Orphaned user blocks (saved name no longer in template) are preserved in a clearly-marked orphan section inserted before the `## :: NAV` footer rather than silently lost.
- Repo profile writer now includes a `## :: YOUR NOTES` section with a `persist:user "notes"` block by default, and preserves the user's content across re-syncs via `extractPersistBlocks` + `mergePersistBlocks`.
- NOTICES updated with pattern-level acknowledgement of `obsidian-zotero-integration` (original pattern) and `LonoxX/obsidian-github-issues` (refinement). No code copied -- logic re-derived with project-specific namespacing.
- **23 new tests** in `src/sanitize/persist.test.ts` + **2 new integration tests** in `repo-profile-writer.test.ts`. Total: **195 tests across 9 suites**.
