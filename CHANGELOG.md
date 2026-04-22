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
