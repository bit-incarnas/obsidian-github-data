# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (background sync / opt-in cron)
- **`src/sync/scheduler.ts`** -- new `BackgroundSyncScheduler` class. Heartbeat-driven `setInterval` loop with three frequency tiers (`HIGH = every tick`, `MEDIUM = every 4 ticks`, `LOW = every 24 ticks`). Six commands map to tiers: issues / PRs at HIGH, activity at MEDIUM, repo profiles / releases / Dependabot at LOW. At the default 15-minute heartbeat: issues / PRs every 15 min, activity every 1 hour, the rest every 6 hours. Pure `pickDueCommands(commands, tickCount)` selector exposed for tests; `SchedulerHostContract` interface lets tests substitute a fake without standing up a full Plugin lifecycle.
- **Lifecycle**: `start()` is idempotent and short-circuits when (a) the toggle is off, (b) no token is set, or (c) the allowlist is empty. `stop()` clears the interval. `restart()` is what the settings tab calls when the toggle or cadence changes. `isRunning()` getter for tests + future status surfaces. Interval id registered via the plugin's `registerInterval` so unload clean-up flows through the standard Obsidian Plugin lifecycle.
- **Rate-limit gate**: each tick consults `RateLimitTracker.getSnapshot()?.remaining` and skips entirely when below `MIN_REMAINING_FOR_BACKGROUND = 100`. Leaves headroom (~2% of the 5000/hr core bucket) for user-initiated runs, the Sync Progress view's auto-refresh, and any other plugins sharing the same PAT. Console-warns on skip; no Notice (background ticks shouldn't be chatty).
- **Failure aggregation**: the tick iterates due commands, aggregates per-command failure counts and labels, emits a single `Notice("GitHub Data: background sync had N failure(s) (X, Y). Open Sync Progress for details.", 8000)` if anything failed, stays silent otherwise. A thrown command does not abort other commands in the same tick (caught individually with a `console.warn` per throw).
- **`src/main.ts`** -- scheduler instantiated in `onload`, started in `onAppReady` (so the first tick lands one full cadence after Obsidian's layout is ready, not racing with startup work). New `restartScheduler()` method exposed for the settings tab. New `silent?: boolean` parameter added to all six `syncAll*` methods (default false; preserves the existing per-command Notice copy for user-initiated runs). All six methods now return `Promise<{ failed: number }>` so the scheduler can read aggregate counts; existing `void this.syncAll*()` call sites continue to work because the return type is additive. `onunload` explicitly calls `scheduler?.stop()` (defensive -- `registerInterval` already auto-cleans, but the explicit stop clears the internal `intervalId` reference).
- **`src/settings/types.ts`** -- new `backgroundSyncEnabled: boolean` (default `false`, strict-boolean coerced via `=== true` so a corrupted JSON `"true"` string can't flip it on) and `lastBackgroundRunAt: Record<string, string>` (per-command ISO timestamps; populated on every successful tick). `clampSyncCadenceMinutes` enforces 1-1440 with a 15-default fallback for malformed values. New `normalizeStringMap` helper rejects non-object payloads. Schema version bumped to `2`.
- **`src/settings/settings-tab.ts`** -- new "Background sync" section. Enable toggle (calls `restartScheduler()` after save), cadence input (1-1440, debounced commit-on-blur to avoid mid-typing saves), and a last-run snapshot listing the per-command ISO timestamps when enabled. `SettingsTabPluginContract` gains an optional `restartScheduler?(): void` so the contract stays compatible with test fixtures that don't bring a scheduler.
- **`tick()` is single-flight + fully swallowed.** New `tickInFlight` boolean drops overlapping ticks (slow run vs short cadence) rather than queueing them. The whole tick body sits in a `try { ... } finally { tickInFlight = false }` so a slow run still releases the guard. `saveSettings()` rejection is caught and `console.warn`-logged inside the tick (the in-memory `lastBackgroundRunAt` is still accurate; the next successful save self-corrects).
- **`lastBackgroundRunAt` is now actually consulted.** The original implementation persisted timestamps but never read them, which meant a manual sync between heartbeats would not push out the next background run by tier cadence. New `hasCadenceElapsed(lastIso, cadenceMs, nowMs)` pure helper filters tier-eligible commands against their last-run timestamp; missing or unparseable timestamps return true (fresh-install case); future-dated timestamps (clock skew, cross-device vault sync) also return true so the scheduler doesn't stall on a phantom past-future window.
- **Preflight gating extracted.** New private `syncPreflight(silent, requireAllowlist)` helper centralizes the token check + allowlist check + silent-Notice gating that was duplicated across all six `syncAll*` entrypoints. Returns either `{ token }` on success or `{ skip: SyncRunResult }` for early-return; activity sync passes `requireAllowlist: false` since it is user-centric and not allowlist-filtered.
- **25 tests in `src/sync/scheduler.test.ts`**: `pickDueCommands` truth table (ticks 0 / 1 / 4 / 7 / 8 / 24), `hasCadenceElapsed` (missing / unparseable / older than cadence / within cadence / future / boundary), start/stop guardrails (disabled / no token / empty allowlist / idempotent start / stop clears), tick behavior (HIGH-only on tick 1, HIGH+MEDIUM on tick 4 with injected clock advancing by cadence, rate-limit skip below threshold, no skip when snapshot null, `lastBackgroundRunAt` recording, throw isolation between commands, failure aggregation without abort, recently-run command suppressed by cadence guard, single-flight drops overlapping ticks, `saveSettings` rejection swallowed). Total: **518 tests across 28 suites**.
- **README** -- new "Enable background sync" + "Cadence (minutes)" rows in the Settings table; the Data-egress section's "no background polls" claim replaced with the opt-in disclosure.
- **`docs/data-egress.md`** -- new "Background sync (opt-in, off by default)" subsection explicitly noting that no new endpoints, payload shapes, or scopes are introduced -- only the "when" changes. Tier policy table, rate-limit-gate behavior, and unload semantics documented. Stale "until the user restarts Obsidian" line on the 401-circuit recovery replaced with the actual UX (Sync Progress view's Reset Circuit button).
- **`ROADMAP.md`** -- v0.2 row marked Shipped; cron polling moved from Near-term checklist to Shipped-surface bullets; status banner updated to "v0.2 complete."
- Bundle growth: 178 KB -> 185 KB (~7 KB for the scheduler module + silent-flag plumbing across the six sync methods + new settings UI section; no new deps).

### Added (Sync Progress view)
- **`src/ui/sync-progress-view.ts`** -- new `SyncProgressView extends ItemView`. Registered under `VIEW_TYPE_SYNC_PROGRESS = "github-data-sync-progress"`. Opens from a new ribbon icon (`refresh-cw`) and a new command (`GitHub Data: Open sync progress`). Renders a per-repo table (repo / last synced / Issues / PRs / Releases / Dependabot / Status) plus a rate-limit snapshot, a "Body sanitation disabled" banner when the Advanced toggle is on, and an "Auth circuit open" banner + Reset button when the shared auth breaker has tripped. Refresh button manually re-renders; vault create/delete/rename events under `02_AREAS/GitHub/Repos/` trigger a debounced (300ms) re-render so live sync progress shows up without user action.
- **`src/ui/sync-progress-data.ts`** -- pure `buildRepoStatusRows(settings, markdownFiles)` + `formatRelativeTime(iso, now)`. Zero Obsidian imports; 100% unit-testable. Counts entities by path-prefix match against `02_AREAS/GitHub/Repos/{owner}__{repo}/{Issues|Pull_Requests|Releases|Dependabot}/`. Case-insensitive match. Does not count the `00_{repo}.md` profile as an entity. Drops malformed allowlist entries silently.
- **`src/settings/types.ts`** -- new `lastSyncError: Record<string, SyncErrorRecord>` field with defensive `normalizeSyncErrorMap` coercion. Unknown / non-object payloads -> empty map; entries missing `at` or `message` dropped; unknown `kind` values coerce to `"unknown"`. Matches the defensive posture already applied to `activitySyncDays` (clamp) and `disableBodySanitation` (strict boolean).
- **`src/main.ts`** -- new `recordSyncError` / `clearSyncError` / `recordSyncOutcome` helpers. All 5 sync loops (`syncAllRepoProfiles`, `syncAllOpenIssues`, `syncAllOpenPullRequests`, `syncAllReleases`, `syncAllDependabotAlerts`) now record the reason on miss and clear on hit. Module-private `classifySyncError` categorizes arbitrary failures into `(message, kind)` with a 240-char message cap so a runaway GitHub payload can't bloat `data.json`. `CircuitOpenError` recognized as `kind: "circuit-open"`; 4xx/5xx inferred from `err.status`; `TypeError` and network-ish strings classified as `"network"`; everything else `"unknown"`. New `resetCircuit()` method wires the Reset button.
- **`src/main.ts`** also drops `private readonly` on `rateLimit` + `circuit` (now `readonly` public) so the view can consult them without reaching into private fields. The CircuitBreaker already exposed `getState` / `getReason` / `reset` public getters from the rate-limit slice.
- **`__mocks__/obsidian.ts`** -- adds `ItemView` and `WorkspaceLeaf` class mocks. `ItemView` lifecycle hooks (`onOpen`, `onClose`, `getViewType`, etc.) are prototype methods so subclass overrides actually run (the prior class-field-initializer pattern shadowed subclass prototype methods).
- **`__mocks__/dom-extensions.ts`** (new) + `jest.config.js` `setupFilesAfterEnv` hook -- jsdom polyfill for the `HTMLElement.prototype` extensions Obsidian ships at runtime (`createDiv`, `createEl`, `empty`, `setText`, `addClass`, `removeClass`, `toggleClass`, `setAttr`, `detach`, `createSpan`). Guards against node-env test files (the three `github/*` suites that run under `@jest-environment node`) so unit-test ergonomics for DOM-bearing code don't break transport-layer tests.
- **`src/settings/types.test.ts`** -- 5 new tests covering `lastSyncError` normalization (default empty, defensive copy, non-object coercion, missing-field drop, unknown-kind coercion).
- **`src/ui/sync-progress-data.test.ts`** -- 15 new tests across row construction + relative-time formatting. Covers empty allowlist, entity counts per folder type, case-insensitive folder matching (GitHub lowercases on sync), cross-repo isolation, settings pass-through, malformed-entry drop, whitespace trim, profile-file exclusion, and the full time-unit ladder (`Ns`/`Nm`/`Nh`/`Nd`/`Nmo`/`Ny`).
- **`src/ui/sync-progress-view.test.ts`** -- 9 new tests exercising the mounted view: empty-state, row population, sanitation-disabled banner on/off, circuit-open banner + reset button, lastSyncError surfacing, Refresh button re-render, and the two rate-limit snapshot cases.
- **`src/main.test.ts`** -- updated for the new command + view + ribbon registrations.
- Total: **485 tests across 27 suites**. Bundle growth: 170 KB -> 178 KB (~8 KB for the view module + data module + polyfill setup).

### Added (sanitizer split + `disableBodySanitation` toggle)
- **`src/sanitize/body.ts`** -- `sanitizeGithubMarkdown(input)` split into two explicit halves: `sanitizeForUserSafety` (strips `<script>` / `<iframe>` / `<object>` / `<embed>` / `<link>` / `<style>` / `<meta>` / `<base>` tags, event-handler attributes, `javascript:` / `data:text/html` URL schemes, `<img>` rewriting, Templater `<% %>` markers, Dataview `` `= `` / `` `$= `` inline queries) and `sanitizeForVaultIntegrity` (wikilink `..` rewrite, persist-block marker escape). Public entry point `sanitizeGithubMarkdown(input, opts?)` now accepts `{ disableUserSafetySanitation?: boolean }`; when true the user-safety passes are skipped but vault-integrity always runs. Default-args call is byte-identical to prior behavior.
- **`src/settings/types.ts`** -- new `disableBodySanitation: boolean` setting (default `false`). `mergeSettings` absorbs it via the default-spread pattern; no schema migration.
- **`src/settings/settings-tab.ts`** -- new "Advanced" section with the toggle and a red warning banner that renders only while the toggle is on. Warning copy explicitly names Templater RCE, Dataview injection, and raw-HTML / `<script>` execution as the trade-off, and notes that wikilink path-escape and persist-block protection remain active.
- **`src/main.ts`** -- each of the 5 sync call sites (`syncRepoProfiles`, `syncRepoIssues`, `syncRepoPullRequests`, `syncRepoReleases`, `syncRepoDependabotAlerts`) threads `disableBodySanitation: this.settings.disableBodySanitation` into the writer context. `activity-writer` doesn't sanitize body content (contribution-count aggregator), so it's unchanged. One-time `console.warn` on plugin load when the toggle is on.
- **5 writers** (`issue-writer`, `pr-writer`, `release-writer`, `dependabot-writer`, `repo-profile-writer`) -- each options interface gains a `disableBodySanitation?: boolean` field; each writer threads the flag through its compose/build helpers to `sanitizeGithubMarkdown(body, { disableUserSafetySanitation })`.
- Rationale: the toggle is a power-user escape hatch for fully-controlled repos where Templater / Dataview / raw-HTML in synced bodies is content, not attack surface. Vault-integrity protections are not user-disableable because a hostile upstream shouldn't be able to manipulate vault path resolution or the persist-block extractor regardless of operator trust.
- **14 new tests across 3 suite groups** (split tests for `sanitizeForUserSafety`, `sanitizeForVaultIntegrity`, and toggle behavior in `sanitizeGithubMarkdown`). Regression guard: default-args call is asserted byte-identical to `{ disableUserSafetySanitation: false }` call across the existing fixture set. Total: **443 tests across 24 suites**.
- **README** -- new "Advanced" subsection under Settings with explicit trade-off copy and the list of what-gets-bypassed-vs-what-always-runs. **`docs/data-schema.md`** -- new `disableBodySanitation` field entry plus corrections on `lastSyncedAt` shape, `activitySyncDays`, and `devVaultGitNoticeShown`.
- Bundle growth: 167 KB -> 170 KB (~3 KB for the split helpers + Advanced UI section; no new deps).

### Added (codeblock processor)
- **`src/codeblock/yaml.ts`** — parses YAML codeblock bodies via Obsidian's `parseYaml`, validates per-type schemas (`github-issue` / `github-pr` / `github-release` / `github-dependabot`), rejects unknown fields (so pasted codeblocks can't smuggle in scope-widening qualifiers), enforces `repo` owner/repo pattern, `limit` range 1-100, list-of-string shape on `labels`/`columns`, typed enums on `state`/`severity`/`sort`/`is_draft`/`prerelease`/`ecosystem`. Size guard at 8 KB chars short-circuits pathological YAML before parsing.
- **`src/codeblock/query.ts`** — pure function `queryEntities(records, args)` that filters frontmatter records by codeblock type + per-type predicates (repo, state, labels AND, author, severity, ecosystem, is_draft, prerelease), sorts (`updated`/`number`/`published` asc/desc; `github-dependabot` sorts severity-desc then updated-desc), and applies the configured limit.
- **`src/codeblock/renderer.ts`** — DOM table builder. Default columns per type; `columns:` arg overrides. File cells render as `class="internal-link"` anchors so Obsidian's click handler resolves them like wiki-links; `html_url` cells render as external links; booleans as `yes`/`no`; arrays as comma-joined. Empty-state + error-tile helpers.
- **`src/codeblock/processor.ts`** — registers four `registerMarkdownCodeBlockProcessor` handlers. Pipeline per render: parse+validate -> allowlist check (H3; uses case-insensitive `isRepoAllowlisted`) -> scan `02_AREAS/GitHub/Repos/**` via `app.metadataCache.getFileCache` -> filter via the query engine -> render. Any failure renders as an inline warning tile instead of throwing, so a bad codeblock doesn't break the note.
- **`src/main.ts`** — calls `registerCodeblockProcessors` from `onload`. No new commands.
- **Safety posture**: `source: synced` only in v0.1 -- the codeblock processor never issues live GitHub requests. Live-fetch lands with the cron slice where the rate-limit wrapper can debounce + cache. YAML-bomb defense via size guard + Obsidian's vetted parser.
- **71 new tests across 4 suites** (`yaml.test.ts`, `query.test.ts`, `renderer.test.ts`, `processor.test.ts`) covering field validation (per-type allowlists, range checks, type guards), filter semantics (state/labels-AND/author/severity/ecosystem/is_draft/prerelease), sort orderings, edge cases (empty, non-string frontmatter), DOM output (internal-link anchors, column overrides, empty-state, error tiles), and the processor's end-to-end flow including allowlist enforcement (positive + case-insensitive match, negative refusal). Total: **421 tests across 24 suites**.
- **README** gained a Codeblocks section with YAML schemas + examples per type.
- Bundle growth: 157 KB -> 167 KB (~10 KB for yaml/query/renderer/processor; no new deps).

### Data egress (codeblock processor)
- **No new endpoints.** Codeblocks query the local vault tree via `metadataCache`; zero network calls on render. Egress table unchanged.

### Fixed (codeblock-processor review pass)
- **Vault-root boundary check** (`src/codeblock/processor.ts`): `scanEntityRecords` was using `file.path.startsWith(vaultRoot)` which matched sibling prefixes -- e.g. `02_AREAS/GitHub` would incorrectly include files under `02_AREAS/GitHub_Other_Folder/...`. New `normalizeVaultRoot` + `isInsideRoot` helpers enforce the directory boundary (trailing-slash aware). Trailing-slash and bare forms of `vaultRoot` now behave equivalently.
- **Allowlist filter applies even when `repo:` is omitted** (`src/codeblock/processor.ts`): previously a codeblock with no `repo:` arg would render every synced record regardless of the current allowlist, so stale files for repos that had been removed from the allowlist would still surface. Records are now filtered by `isRepoAllowlisted(settings.repoAllowlist, frontmatter.repo)` before the query engine runs; records missing a `repo` field are dropped (not a recognizable entity).
- **Case-insensitive label matching** (`src/codeblock/query.ts`): `filterByLabels` lowercases both requested labels and record labels before comparing. `Bug` / `bug` / `BUG` all match. GitHub preserves label display casing, so strict matching was surprising.
- **Internal-link anchor hygiene** (`src/codeblock/renderer.ts`): `renderFileLink` no longer sets `target="_blank"` / `rel="noopener"`. Those attributes are for external links; on internal (`data-href`) links they caused Obsidian to open the link in a browser rather than letting the in-vault click handler navigate.
- **Defensive try/catch around the pipeline** (`src/codeblock/processor.ts`): `processCodeblock` now wraps the whole scan/query/render path in a try/catch. Parse + allowlist failures are still handled inline with clean messages; only unexpected downstream throws hit the outer catch, which renders a warning tile. Keeps the "render warning tile, never break the note" contract under any failure.
- **6 new tests** covering each fix: internal-link anchor target/rel absence, case-insensitive label match (Bug / SECURITY / BUG), vault-root sibling-prefix rejection, vault-root trailing-slash equivalence, allowlist filter with omitted `repo:` arg, error-tile on pipeline crash. Total: **427 tests across 24 suites**.
- **URL-cell scheme allowlist** (`src/codeblock/renderer.ts`): `html_url` / `url` cells now validate the URL scheme before creating an anchor. Only `http:` / `https:` render as clickable links; everything else (`javascript:`, `data:`, `file:`, `obsidian:`, malformed values) renders as plain text. Defense in depth: even though `html_url` is populated by our own writer from GitHub's API response, hand-edited vaults or future columns sourced from less-trusted data shouldn't bypass this check. 2 new tests covering rejected dangerous schemes + acceptance of `http://`. Total: **429 tests across 24 suites**.

### Added (activity aggregator)
- **`src/github/graphql.ts`** — typed wrappers over `client.graphql()` for the two GraphQL queries we need: `fetchViewerLogin` (one-shot `{ viewer { login } }`) and `fetchContributionsCollection(login, from, to)` which returns commits-by-repo + opened PRs (with `merged` / `mergedAt` sub-shape) + opened issues (with `closedAt`) + reviews given. First use of GraphQL in the plugin; wires through Octokit's built-in `client.graphql()` so it benefits from the same auth + HTTP transport.
- **`src/sync/activity-writer.ts`** — `syncActivity(options)` fetches the user's contributionsCollection for the configured window, aggregates into per-day rollups via the pure `aggregateActivityByDay(data)` function, and writes one file per active day at `02_AREAS/GitHub/Activity/YYYY-MM/YYYY-MM-DD.md`.
- Aggregation rules: `commits_total` summed across repos on each UTC day; `prs_opened` / `issues_opened` / `reviews_given` counted on their `occurredAt` date; `prs_merged` derived from each PR's `mergedAt` (counted on merge date, not open date); `issues_closed` from each issue's `closedAt`. Per-repo breakdown captures commits / PRs-opened / issues-opened / reviews-given per repo.
- Frontmatter schema (`type: github_activity_day`, `schema_version: 1`): `date`, `commits_total`, `prs_opened`, `prs_merged`, `issues_opened`, `issues_closed`, `reviews_given`, `releases` (always 0 in this slice -- cross-ref to Releases/ or REST fan-out lands in a follow-up), `last_synced`, `tags: ["github", "activity"]`.
- Body: summary table, per-repo breakdown table (commits-desc ordered), `## :: YOUR NOTES` section with a `{% persist:user "notes" %}` block that survives re-sync via `extractPersistBlocks` + `mergePersistBlocks`.
- **`src/settings/types.ts`** — new `activitySyncDays: number` setting (default 30, max 365 to respect GitHub's contributionsCollection 1-year cap per query). `mergeSettings` coerces + clamps persisted values to the valid range (1-365); malformed / missing / out-of-range values fall back to the default 30.
- **`src/settings/settings-tab.ts`** — new "Activity" section with a number input for the window; commits once on blur rather than on every keystroke (stops transient mid-typing values from triggering N saves).
- **`src/main.ts`** — new command `GitHub Data: Sync activity`. Total commands: 7. Funnels through the shared `this.createClient(token)` factory so activity syncs share the plugin-lifetime rate-limit / circuit / concurrency state with the other sync commands.
- Activity is user-centric, NOT filtered by repo allowlist -- the point is to capture the full contribution picture (the allowlist governs file-per-entity writes, which are repo-centric).
- **33 new tests across 2 suites** in `graphql.test.ts` (13) and `activity-writer.test.ts` (20) covering aggregation correctness, frontmatter emission, persist-block preservation on re-sync, viewer-login auto-resolution, GraphQL error paths, window derivation (UTC-aligned + default fallback), cursor pagination across all three cursored connections, and truncation warnings. Total: **350 tests across 20 suites** (on top of the rate-limit discipline base).

### Data egress (activity aggregator)
- New egress: `POST /graphql` to `api.github.com`. Body = GraphQL query + variables (login, from, to ISO-8601 datetimes); never contains vault data.
- Per `Sync activity` invocation: one `viewer { login }` query whenever the caller omits `login` (no automatic session cache -- callers that want to skip this can pass `login` explicitly), plus one `Contributions` main query, plus up to 10 per-connection follow-up queries per cursored connection (pullRequest / issue / review) when pagination is needed. Typical 30-day window fires 1-2 GraphQL calls.
- All existing call properties still hold: user-initiated, no telemetry, no third-party egress, PAT-only-in-Authorization-header.

### Fixed (activity-aggregator review pass)
- **Window alignment**: `syncActivity` now snaps `from`/`to` to UTC day boundaries (`from` = 00:00:00.000Z of `today - windowDays + 1`; `to` = 23:59:59.999Z of today). Previously used `now - windowDays * 86_400_000`, which mis-aligned with the UTC-day aggregation buckets (first day was partial depending on the local-clock hour at sync time).
- **GraphQL cursor pagination**: `fetchContributionsCollection` now follows `pageInfo.hasNextPage` cursors on `pullRequestContributions`, `issueContributions`, and `pullRequestReviewContributions`. 100-page safety cap per connection with a warning via optional `onWarning` callback. `commitContributionsByRepository` stays at the `maxRepositories: 100` hard cap (GitHub schema limit); warning surfaces when a window returns >=100 repos so the user knows the per-repo breakdown is truncated.
- **mergeSettings clamp**: new `clampActivitySyncDays(raw)` helper sanitizes persisted values (string/number coercion, NaN / missing / negative / overflow all fall back to default 30; upper bound clamped at 365).
- **Shared client in `syncActivityFeed`**: switched from `createGithubClient({ token })` to `this.createClient(token)` so activity syncs share plugin-lifetime rate-limit / circuit / concurrency state (matches the other sync commands).
- **`buildActivityBody` self-link removed**: the NAV footer previously contained a hard-coded self-link `[[02_AREAS/GitHub/Activity/.../date|Activity]]` that (a) linked to itself, (b) ignored a custom `vaultRoot`. Dropped in favor of the single ghost-link `[[YYYY-MM-DD]]` to the daily note.
- **Settings input blur commit**: the `activitySyncDays` input now persists on blur rather than every keystroke (see above).
- **Test rename**: `activity-writer.test.ts` "window derived from windowDays (default 30)" split into two tests -- one for explicit `windowDays: 7` and one for the default-fallback case -- so the title matches behavior.

### Added (rate-limit discipline)
- **`src/github/rate-limit.ts`** — `RateLimitTracker` records `X-RateLimit-{Limit, Remaining, Reset, Used, Resource}` from every response. Plugin-lifetime instance (constructed once in `main.ts`, shared across every sync command) so the budget is global. `isLow()` (default threshold: 500 per security-review H5), `msUntilReset()`, `remainingRatio()` for throttle decisions.
- **`src/github/backoff.ts`** — `computeBackoff(attempt, opts)` returns `base * 2^attempt + jitter`, capped at 1hr (failure-mode table). Jitter prevents multi-device synchronized retry storms. `sleep(ms)` helper. Random + sleep injected for tests.
- **`src/github/circuit-breaker.ts`** — `CircuitBreaker` + `CircuitOpenError`. Opens after 2 consecutive 401s (design threshold); opens immediately on 403-with-`x-github-sso: required`. Once open, further requests throw `CircuitOpenError` *without* firing inner; preserves all synced vault data (the design's explicit preservation requirement on 401 twice). `recordSuccess` clears the counter on any non-auth-failing response. Reset UX lands with the cron slice.
- **`src/github/concurrency.ts`** — FIFO `Semaphore` caps in-flight requests at 4 (failure-mode table). `run(fn)` acquires/releases via try/finally so slots never leak on throw.
- **`src/github/fetch-wrapper.ts`** — `wrapWithRateLimit` composes the above into a `typeof fetch` decorator that sits between Octokit and the transport layer. Retry logic per the failure-mode table: 401 once → retry; 401 twice → trip circuit + propagate; 403-SSO → trip circuit; 403-rate-limit → sleep until `X-RateLimit-Reset`; 429 → sleep `max(Retry-After, exp-backoff)`; 5xx → exp-backoff + jitter; `status === 0` / TypeError → exp-backoff + retry. Success (2xx/3xx) clears the 401 counter.
- **`src/main.ts`** — plugin now holds `rateLimit`, `circuit`, `concurrency` as plugin-lifetime fields; all 6 sync commands funnel through `createClient(token)` so a 401 in one command trips for all subsequent commands (user acts once, resets once). Settings-tab's Test-Connection still uses isolated state so re-testing after a token swap always fires.
- Distinguishing 403 rate-limit (`X-RateLimit-Remaining: 0` or body mentioning "rate limit") from 403 auth (propagated, no retry).
- `Retry-After` parsing handles both integer seconds and HTTP-date formats.
- Bundle growth: 141 KB → 146 KB (~5 KB for the wrapper + state classes; unchanged Octokit surface).
- **82 new tests across 5 suites** in `rate-limit.test.ts`, `backoff.test.ts`, `circuit-breaker.test.ts`, `concurrency.test.ts`, `fetch-wrapper.test.ts`. `client.test.ts` updated for the retry behavior (401 now fires twice before propagating; status === 0 exhausts retries). Total: **317 tests across 18 suites**.

### Data egress
- No new endpoints. Observable change: failed requests may now retry with exponential backoff + jitter (max 3 retries by default). 429 / 5xx / network failures no longer propagate on the first attempt -- they back off then retry, capped at 1hr per sleep and 3 retries per request. 401 retries exactly once before tripping the circuit. Circuit-open state blocks further requests client-side; no requests are issued until the user restarts Obsidian (proper reset UX ships with the cron slice).

### Deferred
- **ETag conditional requests + 304 handling** — `If-None-Match` cache + 304 "no-change" signaling has consumer-side implications across all 5 writers (skip-write-on-304). Lands alongside cron, where the cheap-poll pattern is the point.
- **Initial-sync budget** (< 500 req in first 10 min) — requires persistent "first sync" timestamp state. Lands alongside cron.
- **404-archive / 410-delete semantics** — touches writers + user-confirmation dialog for 410. Separate retention-policy slice.
- **Multi-device soft-mutex** (H6) — separate candidate; uses `last_synced` comparison across devices.
- **CircuitBreaker reset UX** — Settings-tab action to reset after the user re-enters a token. Ships with cron.
- **`releases` daily count** — cross-ref to Releases/ folder or REST fan-out per repo. Lands in a follow-up slice.

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
