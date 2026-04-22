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

### Data egress
- **Still zero outbound calls from `src/main.ts`.** The HTTP client exists but isn't wired into the plugin lifecycle yet. Integration tests call real GitHub only when run manually with `GH_TEST_TOKEN`.
