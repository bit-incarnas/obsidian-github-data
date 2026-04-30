# GitHub Data

Obsidian plugin that mirrors GitHub state — repos, issues, pull requests, releases, Dependabot alerts — into vault-native markdown files. **Pull-in only:** vault data stays in the vault; the plugin only calls out to `api.github.com` for the data it's explicitly configured to pull. Calls fire on user-triggered commands by default, or on the opt-in background-sync heartbeat (off by default; see Settings → GitHub Data → Background sync). Either way, no startup auto-fetches and no new destinations beyond the documented egress table.

Built to make GitHub state queryable via [Dataview](https://github.com/blacksmithgu/obsidian-dataview), graph-integrated, and link-friendly inside the vault.

> **Status:** pre-alpha. Usable against real GitHub but not yet in the community directory. Installable via [BRAT](https://github.com/TfTHacker/obsidian42-brat).

---

## What it does

Once installed and configured with a fine-grained GitHub PAT + an allowlist of repos, five commands pull data into the vault:

| Command | Writes to |
| :------ | :-------- |
| `GitHub Data: Sync all repo profiles` | `02_AREAS/GitHub/Repos/{owner}__{repo}/00_{repo}.md` — repo metadata + README |
| `GitHub Data: Sync all open issues` | `.../Issues/{number}-{slug}.md` — one file per open issue |
| `GitHub Data: Sync all open pull requests` | `.../Pull_Requests/{number}-{slug}.md` — one file per open PR |
| `GitHub Data: Sync all releases` | `.../Releases/{tag}.md` — one file per release |
| `GitHub Data: Sync all open Dependabot alerts` | `.../Dependabot/{number}-{package}-{severity}.md` |
| `GitHub Data: Hydrate project charters` | `gh_*` frontmatter on every vault file with `github_repo: owner/repo` |

Every synced file:
- Carries structured frontmatter (Dataview-queryable out of the box).
- Includes a `## :: YOUR NOTES` section with a `{% persist:user "notes" %}` block that survives re-syncs. Your annotations on GitHub-sourced content are never clobbered.
- Lands inside a path-contained location — owner/repo names coming from GitHub can't traverse out of the designated root.
- Has its body content sanitized (`<script>`, Templater `<% %>`, Dataview `` `= ``, `<iframe>`, `javascript:` URLs, etc. all neutralized) before landing in the vault, so other plugins that auto-process markdown (Templater in particular) can't execute hostile content from a compromised issue body.

## Safety posture

- **Read-only GitHub scopes** in v0.1 — plugin cannot write to your repos until a future release opts into specific write endpoints.
- **No telemetry, no third-party error reporting, no phone-home.** Errors go to a local log only.
- **Token storage** via Obsidian's `SecretStorage` API (Obsidian 1.11+) when available, with an explicit "Migrate to SecretStorage" flow. Migration CTA copy includes the crucial rotation warning — the original token is considered leaked once it's touched `data.json`.
- **Body sanitizer** (middle-ground H1) neutralizes the common RCE / tracking / injection vectors before synced content hits the disk.
- **Path containment** rejects hostile `owner` / `repo` names that could traverse outside the designated output folders. Homoglyph / Windows-reserved / empty-tag / length-bomb defenses all layered.
- **Persist-block markers** in GitHub-sourced content are escaped so an attacker can't inject a survive-across-sync block via a hostile issue body.

Full disclosure: [`docs/data-egress.md`](docs/data-egress.md) + [`docs/data-schema.md`](docs/data-schema.md).

## Setup

1. **Install.** Via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `bit-incarnas/obsidian-github-data` as a beta plugin.
2. **Pick a token type.** Two shapes work; the choice depends on whether you want `Sync activity` to capture your full contribution graph or only the repos visible to the token. (`Sync activity` is user-centric and is not filtered by the repo allowlist — only the five repo-scoped commands are.)
   - **Fine-grained PAT (recommended for repo-scoped syncs).** [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens). Read-only scopes:
     - `Contents: read` (README)
     - `Issues: read`
     - `Pull requests: read`
     - `Metadata: read`
     - `Dependabot alerts: read`
     - `Actions: read` (future enrichment)

     **Repository access matters for `Sync activity`.** GitHub's `viewer.contributionsCollection` only returns contributions to repos the token can see. If Repository access is set to "Only select repositories," every commit / PR / issue / review on any unscoped repo is silently dropped — the activity sync succeeds with zero or near-zero day files. To capture your full contribution graph, switch Repository access to **All repositories**. The five repo-scoped commands (issues, PRs, releases, profiles, Dependabot) work fine on a narrow allowlist either way.
   - **Classic PAT (simplest path for `Sync activity`).** [github.com/settings/tokens](https://github.com/settings/tokens). Scopes: `read:user` (lets `viewer.contributionsCollection` return private contributions) plus `repo` if any of the contributions you want counted are to private repos. Public-only contributions don't need `repo`. Wider blast radius than a scoped fine-grained PAT, but the plugin remains read-only.
3. **Enter the PAT.** Settings → GitHub Data → Personal access token.
4. **Migrate to SecretStorage** (recommended). If Obsidian 1.11+, click "Migrate to SecretStorage" — this moves the token out of plaintext into OS-level encrypted storage.
5. **Rotate the original token.** Required after migration. The original value is already in `data.json` (and possibly in git history / Obsidian Sync history / SSD slack) — rotate it on GitHub.
6. **Add repos to the allowlist.** Settings → GitHub Data → Repositories → add `owner/repo` strings.
7. **Test the connection.** Settings → Test connection. Hits `GET /user` and reports your login + rate-limit remaining.
8. **Run the sync commands** from the command palette. They all stream progress and an ok/failed count via Notice.

## Data egress — the whole list

Every outbound call this plugin can make, exhaustively documented:

| Call | Trigger | Payload |
| :--- | :------ | :------ |
| `GET /user` | Test Connection button | PAT header; no body |
| `GET /repos/{o}/{r}` + `/readme` | Sync all repo profiles | PAT header; path params; no vault content |
| `GET /repos/{o}/{r}/issues` | Sync all open issues | PAT header; `state=open&per_page=100`; paginated |
| `GET /repos/{o}/{r}/pulls` | Sync all open pull requests | PAT header; `state=open&per_page=100`; paginated |
| `GET /repos/{o}/{r}/releases` | Sync all releases | PAT header; `per_page=100`; paginated |
| `GET /repos/{o}/{r}/dependabot/alerts` | Sync all open Dependabot alerts | PAT header; `state=open&per_page=100`; paginated |

**No auto-fetches on startup.** Calls are user-initiated by default, or scheduled by the opt-in **background sync** (Settings → GitHub Data → Background sync) which is **off by default**. When enabled, the same calls listed above fire on a configurable cadence (default 15 min heartbeat); no new destinations, payload shapes, or scopes are introduced. Background ticks skip themselves when the rate-limit budget is below 100. Vault content never leaves the vault.

## Charter hydration (opt-in)

Vault files (project charters, HUD pages, daily-note templates, anything) can opt into having their frontmatter automatically populated with synced GitHub state by adding a single line:

```yaml
---
project: my-project
github_repo: owner/repo   # opt in
---
```

Run `GitHub Data: Hydrate project charters` from the command palette. Every vault file whose frontmatter contains `github_repo: owner/repo` (where the repo is in your allowlist and has been previously synced via `Sync all repo profiles` etc.) gets these keys merged into its frontmatter:

| Key | Source |
| :-- | :----- |
| `gh_repo` | Echoed from `github_repo` (canonicalized lowercase) |
| `gh_open_issues` | Count of files under `02_AREAS/GitHub/Repos/{o}__{r}/Issues/` |
| `gh_open_prs` | Count under `Pull_Requests/` |
| `gh_open_dependabot_alerts` | Count under `Dependabot/` |
| `gh_last_release` | Tag of the release with the most recent `published_at`, or `null` |
| `gh_default_branch` | From the synced repo profile |
| `gh_last_synced` | From the synced repo profile (when the source was last refreshed) |
| `gh_hydrated_at` | When the charter's `gh_*` block last actually changed |

Properties:

- **Read-only against GitHub.** No new API calls. Hydration is a vault-to-vault transformation over already-synced data.
- **Body is never touched.** Only frontmatter, only the `gh_*` keys.
- **Idempotent.** A re-run with no source changes is a no-op (the file's `mtime` is not bumped, so Obsidian Sync / iCloud / git don't see churn).
- **`gh_hydrated_at` only advances when the data changes**, so it tracks "last real change" not "last button press."
- **Charters without the marker are never modified.** No path globs to configure; the marker is the entire opt-in.
- **Allowlist still gates.** A charter declaring `github_repo: evil-org/exfil` is skipped with a console warning if the repo isn't in your allowlist.

## Codeblocks

Four `github-*` codeblocks render tables inline in any note, querying the vault's synced entity files (never the live API) via `metadataCache`. Allowlist is enforced at render time -- queries against unallowlisted repos render an error tile instead of data.

````markdown
```github-issue
repo: bit-incarnas/eden
state: open
labels:
  - bug
limit: 10
```

```github-pr
repo: bit-incarnas/eden
state: open
is_draft: false
sort: number-desc
```

```github-release
repo: bit-incarnas/eden
prerelease: false
limit: 5
```

```github-dependabot
repo: bit-incarnas/eden
severity: high
```
````

Per-type fields:

| Codeblock | Filters |
| :-------- | :------ |
| `github-issue` | `repo`, `state` (`open|closed|all`), `labels` (list, AND), `author`, `sort` (`updated-desc`/`-asc`, `number-desc`/`-asc`), `limit` (1-100), `columns` |
| `github-pr` | issue fields + `is_draft` (true/false) |
| `github-release` | `repo`, `prerelease`, `sort` (`published-desc`/`-asc`), `limit`, `columns` |
| `github-dependabot` | `repo`, `severity` (`critical|high|medium|low|all`), `state` (`open|all`), `ecosystem`, `limit`, `columns` |

Each codeblock type has sensible default columns; override via `columns: [number, title]` etc. Queries are `source: synced` only in this release -- they read `02_AREAS/GitHub/Repos/{owner}__{repo}/**` and never fire live API calls.

## Settings

| Setting | Purpose |
| :------ | :------ |
| Personal access token | The PAT used for all API calls |
| Migrate to SecretStorage | One-click move of plaintext PAT into OS keychain |
| Test connection | Validates the token against `GET /user` |
| Clear token | Removes token from both SecretStorage and `data.json` |
| Repository allowlist | `owner/repo` strings the plugin is allowed to sync; codeblock queries (future) will also enforce this |
| Activity window (days) | How many days back from today to pull when running `Sync activity` (1-365) |
| Enable background sync | Master switch for the heartbeat. Off by default. When on, sync commands fire on the cadence below |
| Cadence (minutes) | Heartbeat interval for background sync (1-1440; default 15). High tier (issues / PRs) fires every tick; medium (activity) every 4 ticks; low (repo profiles / releases / Dependabot) every 24 ticks |
| Disable body sanitation | Advanced / power-user escape hatch. See below |

### Advanced

**Disable body sanitation** is an escape hatch for power users who sync only repos they fully control and want to preserve Templater / Dataview / raw-HTML content verbatim. Default is **off** -- leave it off unless you know why you want it on.

When the toggle is on, the sanitizer's **user-safety** passes are bypassed on every body write (issues, PRs, releases, repo READMEs, Dependabot advisory descriptions). Specifically, these are NO LONGER neutralized:

- `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<style>`, `<meta>`, `<base>` tags
- Event-handler attributes (`onclick`, `onerror`, etc.)
- `javascript:` and `data:text/html` URL schemes
- `<img>` rewriting to safer markdown form
- Templater markers `<% ... %>` and `<%* ... %>`
- Dataview inline queries `` `= ... ` `` and `` `$= ... ` ``

A crafted issue body on any allowlisted repo can now execute code in your vault via Templater auto-run, run arbitrary Dataview / DataviewJS queries, or ship arbitrary HTML / JavaScript.

**Vault-integrity** passes always run regardless of this setting:

- Wikilinks containing `..` are rewritten so synced content can't link out of the vault root.
- `{% persist:user ... %}` / `{% persist:template ... %}` markers in GitHub-sourced content are escaped so hostile upstream content can't inject a persist block that survives re-sync.

The plugin logs a one-time `console.warn` on load whenever the toggle is on; the settings tab renders a red warning banner next to the toggle. If you flip this on and forget it's on months later, that's on you.

## Sync progress view

Opens a read-only dashboard in the right sidebar showing per-repo sync status. Zero network calls -- the view reads `data.json` + the vault's markdown file list.

Two ways to open:
- **Ribbon icon:** the refresh-cw icon in the left ribbon.
- **Command palette:** `GitHub Data: Open sync progress`.

What it shows:
- Per-repo table: **Last synced** (relative -- `2h ago`, `never`), entity counts for **Issues / PRs / Releases / Dependabot**, and a **Status** column that surfaces any recorded sync failure with a kind badge (`http-4xx`, `http-5xx`, `network`, `circuit-open`, `unknown`).
- **Rate-limit snapshot:** current remaining / limit from the most recent API response.
- **"Auth circuit open" banner + "Reset circuit" button** when the shared auth breaker has tripped (two consecutive 401s, or a 403 with `x-github-sso: required`). Reset clears the breaker so the next sync attempt fires normally.
- **"Body sanitation disabled" banner** when the Advanced toggle is on.

The view auto-refreshes when markdown files land in or leave the synced tree (`02_AREAS/GitHub/Repos/`) -- so running a sync command updates the counts live.

## Development

Requires Node 22+ and npm 10+.

```bash
npm install       # also wires up the pre-push hook (see below)
npm run dev       # esbuild watch -> main.js
npm test          # jest (235 tests across 13 suites)
npm run build     # typecheck + production build
```

Run the integration test suite against real GitHub (token never persisted to disk):

```bash
GH_TEST_TOKEN=$(gh auth token) npm run test:integration
```

`npm install` runs a `prepare` script that sets `core.hooksPath` to `hooks/`, wiring up the `pre-push` hook that blocks direct pushes to `main`. The remote branch-protection ruleset rejects such pushes anyway; the local hook just fails faster with a friendly reminder. Bypass with `git push --no-verify` (server still rejects).

Workflow:

```bash
git switch -c feature/<short-name>
# ...work...
git push -u origin HEAD
gh pr create --fill
# CI runs; merge when green
```

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the public phase ladder, shipped surface, and what's deliberately not in scope.

## License

MIT. See [LICENSE](LICENSE).

Third-party code fragments incorporated into this plugin are tracked in [NOTICES](NOTICES) with their upstream licenses. Pattern-level acknowledgements (ideas, architecture) are noted there even when no code was copied.
