# Roadmap

Phase ladder for `obsidian-github-data`. Internal design doc is authoritative; this file is a public mirror.

> **Status:** pre-alpha. Currently shipping `v0.0.5` with the activity-aggregator viewer-form fix. v0.2 of the design ladder is closing out (3/5 done); cron polling and an SOP draft are the remaining items.

## Phase ladder

| Phase | Scope | Status |
| :---- | :---- | :----- |
| **v0.1 (MVP)** | Repo / open issue / open PR sync. Fine-grained PAT auth. SecretStorage migration. Allowlist editor. | Shipped |
| **v0.2** | Dependabot sync. Releases sync. Daily activity aggregation. Cron polling. SOP draft. | 3 / 5 — Dependabot, releases, activity ✅. Cron polling and SOP draft remaining. |
| **v0.3** | Charter hydration. Commit activity → Telemetry Grid feed. Contribution heatmap wiring. | Not started. Activity aggregator unblocks the data side. |
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

## Near-term (v0.2 close-out)

1. **Cron polling.** Wire `syncCadenceMinutes` (already in settings, default 15) to a `setInterval` loop that fires syncs through the existing `Semaphore` so background polls don't starve user-initiated commands. Default off until opted in; data-egress doc gets a corresponding update.
2. **`SOP_023_GitHub_Sync_Protocol`.** Outline-form draft covering invocation surface, output schema, audit pass, failure modes, recovery. Hardened in v0.3.

## v0.3 candidates

- **Telemetry Grid Dataview query** over `02_AREAS/GitHub/Activity/**/*.md` for daily `commits_total`.
- **Heatmap Calendar** integration over the same folder for contribution-graph rendering inside Obsidian.
- **Project-charter hydration** — synced repo-profile fields (open PR count, last release, default branch) flow into matching charter notes' frontmatter.

## What's deliberately not on the ladder

- **Write-back to GitHub.** v0.x is read-only by design. Future write endpoints will land behind explicit per-endpoint opt-ins and updated scope docs.
- **Background sync of vault content out to GitHub.** Vault data stays in the vault; the plugin only calls `api.github.com` and only for what's configured.
- **Telemetry / error reporting.** Errors land in a local log only.

## Known gotchas

- **`Sync activity` requires broad token visibility.** GitHub's `viewer.contributionsCollection` only returns contributions to repos the token can see. A fine-grained PAT scoped to "Only select repositories" silently drops every commit / PR / issue / review on unscoped repos. The five repo-scoped commands (issues / PRs / releases / profiles / Dependabot) are unaffected — they iterate the explicit allowlist. See README §Setup for the supported token shapes.
