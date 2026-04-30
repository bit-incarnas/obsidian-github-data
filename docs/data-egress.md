# Data Egress

User-facing disclosure of what data leaves your machine when this plugin runs. Matches the binding [data-egress policy](https://github.com/bit-incarnas/obsidian-github-data/blob/main/docs/policy/data-egress.md) of the plugin program.

**Principle:** vault data stays in the vault. This plugin pulls data *in* from GitHub; it does not push vault contents *out* except when an explicit user-invoked command (in a future phase) requests it.

## Current state (scaffold + HTTP + settings + repo profile writer + issue writer)

| Outbound call | Destination | Trigger | Payload | Notes |
| :------------ | :---------- | :------ | :------ | :---- |
| `GET /user` | `api.github.com` | User clicks "Test connection" in Settings -> GitHub Data | `Authorization: Bearer <PAT>`, `User-Agent: obsidian-github-data` headers; no body; no vault content | User-initiated. |
| `GET /repos/{owner}/{repo}` | `api.github.com` | User runs `GitHub Data: Sync all repo profiles` | Same auth + UA headers; path params only | User-initiated. One request per allowlisted repo. |
| `GET /repos/{owner}/{repo}/readme` | `api.github.com` | Same command, same iteration | Same auth + UA; `Accept: application/vnd.github.raw` | User-initiated. 404 tolerated. |
| `GET /repos/{owner}/{repo}/issues` | `api.github.com` | User runs `GitHub Data: Sync all open issues` | Same auth + UA; `state=open&per_page=100` query; multi-page via `Link` header | User-initiated. Paginated. |
| `GET /repos/{owner}/{repo}/pulls` | `api.github.com` | User runs `GitHub Data: Sync all open pull requests` | Same auth + UA; `state=open&per_page=100`; multi-page | User-initiated. Paginated. |
| `GET /repos/{owner}/{repo}/releases` | `api.github.com` | User runs `GitHub Data: Sync all releases` | Same auth + UA; `per_page=100`; multi-page | User-initiated. Paginated. |
| `GET /repos/{owner}/{repo}/dependabot/alerts` | `api.github.com` | User runs `GitHub Data: Sync all open Dependabot alerts` | Same auth + UA; `state=open&per_page=100`; multi-page | User-initiated. Paginated. 404 (alerts disabled on the repo) is tolerated as an empty list rather than a failure. |
| `POST /graphql` (viewer lookup) | `api.github.com` | User runs `GitHub Data: Sync activity` (first call) | Same auth + UA; body: `{ query: "query { viewer { login } }" }`; no vault content | User-initiated. One-shot per run; can be skipped if the caller passes `login` explicitly. |
| `POST /graphql` (contributionsCollection) | `api.github.com` | User runs `GitHub Data: Sync activity` | Same auth + UA; body: GraphQL query + variables `{ login, from, to }` (ISO-8601 datetimes); no vault content | User-initiated. Returns commits-by-repo + opened-PR / opened-issue / reviews for the window. Window defaults to 30 days; capped at 365 by the settings UI (GitHub's contributionsCollection limit per query). |

All outbound calls listed above are triggered either **user-initiated** (clicking a settings button or invoking a command) or by the **opt-in background sync** described below. No auto-fetches on startup.

### Background sync (opt-in, off by default)

Settings -> GitHub Data -> "Background sync" exposes a toggle (default **off**) and a heartbeat cadence (default 15 minutes; range 1-1440). When enabled, the plugin fires the same sync commands listed above on a schedule -- no new destinations, no new payload shapes, no different headers. The only behavior change is "when" the calls fire.

Tier policy on each tick:

| Tier | Cadence (at default 15 min heartbeat) | Commands |
| :--- | :------------------------------------ | :------- |
| High | every tick (15 min) | issues, PRs |
| Medium | every 4 ticks (1 hr) | activity |
| Low | every 24 ticks (6 hr) | repo profiles, releases, Dependabot |

Background ticks are skipped entirely when the most recent rate-limit snapshot reports fewer than 100 remaining requests, leaving headroom for user-initiated syncs. Failures from background runs aggregate into a single `Notice`; successful background runs are silent. Per-repo failures land in `lastSyncError` exactly as user-initiated runs do, so the Sync Progress view surfaces them with no extra wiring.

Disabling the toggle stops the heartbeat immediately. Stopping or unloading the plugin clears the timer.

The **HTTP layer** in `src/github/` is built on `@octokit/core` + plugin-paginate-rest + plugin-rest-endpoint-methods, integrated via Octokit's canonical `request.fetch` override wrapping Obsidian's `requestUrl`. It sets `Authorization: token <PAT>` and `User-Agent: obsidian-github-data` on every call.

**Retry behavior** (added in the rate-limit-discipline slice): failed requests may retry with exponential backoff + jitter. Specifically:
- `401 Unauthorized` retries exactly once (per the design's "fresh connection" policy); a second consecutive 401 trips an in-process circuit breaker that blocks further requests until the user clicks **Reset circuit** in the Sync Progress view.
- `429 Too Many Requests` sleeps `max(Retry-After, exp-backoff)` then retries.
- `403` with a rate-limit body or `X-RateLimit-Remaining: 0` sleeps until `X-RateLimit-Reset` then retries.
- `403` with `x-github-sso: required` trips the circuit immediately (no retry).
- `5xx` and transport-level failures (status === 0) back off + retry.
- Default retry budget: **3 attempts per request**, **1-hour cap on any single sleep**.
- Max **4 in-flight requests** at a time (FIFO-queued).

These retries are confined to the same endpoints listed in the table above -- no new destinations are introduced.

The integration test suite (`npm run test:integration`) can also fire outbound calls when run manually with an explicit `GH_TEST_TOKEN` env var. That env var is never set in CI.

Telemetry: **none**.
Third-party error reporting: **none**.
CDN fetches: **none** (plugin bundles its own assets).

## Phase 1 planned (v0.1) -- read-only sync

When the HTTP layer lands, outbound calls will expand to:

| Outbound call | Destination | Trigger | Payload |
| :------------ | :---------- | :------ | :------ |
| `GET /user` | `api.github.com` | Startup auth verification | `Authorization: Bearer <PAT>` header |
| `GET /repos/{owner}/{repo}` | `api.github.com` | Per-repo sync | PAT header; path params |
| `GET /repos/{owner}/{repo}/issues` | `api.github.com` | Per-repo sync | PAT header; path + query params |
| `GET /repos/{owner}/{repo}/pulls` | `api.github.com` | Per-repo sync | PAT header; path + query params |
| `GET /notifications` | `api.github.com` | GitHub Console view open | PAT header |
| `POST /graphql` | `api.github.com` | Deep PR fetch, contribution graph | PAT header; GraphQL query body |

**Never in request bodies:** contents of any vault file, plugin settings, or any locally-derived data other than what the path/query parameters require.

**Authentication data** (PAT) leaves your machine only in the `Authorization` header, only to `api.github.com`. The PAT itself is stored locally -- see [data-schema.md](data-schema.md).

## Not present

- No analytics, telemetry, or usage counters.
- No error reporting to third-party services. Errors are logged locally only.
- No CDN fetches during runtime. All plugin assets ship with the plugin bundle.
- No web sockets or server-sent events outside of `api.github.com`.

## How to audit yourself

The plugin's CI runs a grep audit on every release:

```bash
grep -rEn 'requestUrl|fetch\(|XMLHttpRequest|new WebSocket|EventSource|sendBeacon' src/
```

Every hit should map to an entry in this table. If you see a hit that isn't documented, open an issue.
