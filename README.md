# GitHub Data

Obsidian plugin that mirrors GitHub state — repos, issues, pull requests, releases, Dependabot alerts — into vault-native markdown files. **Pull-in only:** vault data stays in the vault; the plugin only calls out to `api.github.com` for the data it's explicitly configured to pull, and only when you trigger a sync.

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
2. **Create a fine-grained PAT.** At [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens), create a token with **read-only** access to the repos you want to sync. Required scopes:
   - `Contents: read` (README)
   - `Issues: read`
   - `Pull requests: read`
   - `Metadata: read`
   - `Dependabot alerts: read`
   - `Actions: read` (future enrichment)
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

**No background polls. No scheduled syncs. No auto-fetches on startup.** Every call is user-initiated via a settings button or command-palette command. Vault content never leaves the vault.

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

## License

MIT. See [LICENSE](LICENSE).

Third-party code fragments incorporated into this plugin are tracked in [NOTICES](NOTICES) with their upstream licenses. Pattern-level acknowledgements (ideas, architecture) are noted there even when no code was copied.
