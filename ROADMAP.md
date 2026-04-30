# Roadmap

Phase ladder for `obsidian-github-data`. Internal design doc is authoritative; this file is a public mirror.

> **Status:** pre-alpha. v0.3 in progress — **charter hydration** has shipped (opt-in `github_repo` frontmatter marker pulls synced GitHub state into project charters). Telemetry Grid Dataview query and Heatmap Calendar wiring are vault-side tasks that consume the already-shipped activity data; no plugin code needed for those.

## Phase ladder

| Phase | Scope | Status |
| :---- | :---- | :----- |
| **v0.1 (MVP)** | Repo / open issue / open PR sync. Fine-grained PAT auth. SecretStorage migration. Allowlist editor. | Shipped |
| **v0.2** | Dependabot sync. Releases sync. Daily activity aggregation. Background sync (opt-in cron). Operator SOP. | Shipped |
| **v0.3** | Charter hydration. Commit activity → Telemetry Grid feed. Contribution heatmap wiring. | Charter hydration ✅ (this milestone). Telemetry Grid + Heatmap are vault-side wiring over already-shipped data — no plugin code. |
| **v0.4** | GitHub Actions / workflow visibility. CodeRabbit reviews as a first-class entity type. | Not started. |
| **v0.5** | Webhook receiver. Daily-note Flight Log auto-entries on merges + releases. | Not started. |
| **v1.0** | OAuth device flow. Community-directory submission. Hardened SOP set. | Not started. |

## Shipped surface

Concrete features in production today, in the order they landed:

- Repo profile sync (`02_AREAS/GitHub/Repos/{owner}__{repo}/00_{repo}.md`)
- Open issue sync (per-issue files with frontmatter + persist blocks)
- Open PR sync
- Release sync
- Dependabot alert sync
- Daily activity aggregation (`02_AREAS/GitHub/Activity/YYYY-MM/YYYY-MM-DD.md`) via `viewer.contributionsCollection`
- Codeblock processors: `github-issue`, `github-pr`, `github-release`, `github-dependabot` — Dataview-style filtered tables, zero network at render time, allowlist-enforced
- Sync Progress view (right-sidebar dashboard, per-repo status, sync-failure kind badges, rate-limit snapshot, auth-circuit reset)
- HTTP discipline: rate-limit tracker, circuit breaker (401x2 trips, 403+SSO opens), retry with exp-backoff + jitter, concurrency semaphore — all shared across sync commands
- Body sanitizer with explicit user-safety / vault-integrity split and a `disableBodySanitation` power-user toggle
- Path containment: homoglyph, Windows-reserved, length-bomb, and traversal defenses on owner/repo segments
- Persist-block protection: `{% persist:user "notes" %}` survives every re-sync; markers in GitHub-sourced content are escaped
- Opt-in background sync — heartbeat with three frequency tiers, rate-limit-aware, off by default. Settings → GitHub Data → Background sync
- Charter hydration — `github_repo: owner/repo` frontmatter marker opts a vault file into having its `gh_*` keys auto-populated from synced data. Idempotent, body-preserving, allowlist-gated, no new API calls.

## v0.3 remaining (vault-side)

- **Telemetry Grid Dataview query** over `02_AREAS/GitHub/Activity/**/*.md` for daily `commits_total`. Lives in your Telemetry Grid note; no plugin code.
- **Heatmap Calendar** integration over the same folder for contribution-graph rendering inside Obsidian. Configure the third-party Heatmap Calendar plugin to point at the Activity folder; no plugin code.

## What's deliberately not on the ladder

- **Write-back to GitHub.** v0.x is read-only by design. Future write endpoints will land behind explicit per-endpoint opt-ins and updated scope docs.
- **Background sync of vault content out to GitHub.** Vault data stays in the vault; the plugin only calls `api.github.com` and only for what's configured.
- **Telemetry / error reporting.** Errors land in a local log only.

## Known gotchas

- **`Sync activity` requires broad token visibility.** GitHub's `viewer.contributionsCollection` only returns contributions to repos the token can see. A fine-grained PAT scoped to "Only select repositories" silently drops every commit / PR / issue / review on unscoped repos. The five repo-scoped commands (issues / PRs / releases / profiles / Dependabot) are unaffected — they iterate the explicit allowlist. See README §Setup for the supported token shapes.
