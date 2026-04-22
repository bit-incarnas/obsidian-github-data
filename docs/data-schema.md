# Data Schema

User-facing disclosure of what the plugin stores locally and where. Companion to [data-egress.md](data-egress.md).

## Storage locations

### 1. Obsidian `SecretStorage` (preferred, Obsidian 1.11+)

**What:** your GitHub Personal Access Token.
**Where:** OS-level secure storage -- macOS Keychain, Linux Secret Service (libsecret), Windows Credential Manager -- accessed via Electron's `safeStorage` API.
**Encryption:** yes, at rest.
**When:** used by default when Obsidian exposes `app.secretStorage`. Plugin offers a "Migrate to SecretStorage" button in settings on first run if an older token is found in plaintext `data.json`.

### 2. Plugin `data.json` (fallback)

**What:** plugin settings + (if `SecretStorage` is unavailable) the PAT in plaintext.
**Where:** `<your-vault>/.obsidian/plugins/github-data/data.json`
**Encryption:** **none**. Plain JSON.
**When:** fallback only -- used when `SecretStorage` is unavailable (older Obsidian, some mobile configurations).

Fields written to `data.json`:

| Field | Type | Purpose |
| :---- | :--- | :------ |
| `schemaVersion` | number | Schema version for migration. |
| `repoAllowlist` | string[] | `owner/repo` pairs to sync. |
| `token` | string | PAT, only when SecretStorage unavailable; empty otherwise. |
| `useSecretStorage` | boolean | Whether PAT is in SecretStorage. |
| `secretTokenName` | string | SecretStorage key name when migrated. |
| `syncCadenceMinutes` | number | Background sync interval (default 15). |
| `lastSyncedAt` | ISO-8601 | Last successful sync timestamp per repo. |
| `logLevel` | string | `debug` / `info` / `warning` / `error`. |

> **If SecretStorage is unavailable** and your vault is under version control, add `.obsidian/plugins/github-data/data.json` to `.gitignore` -- the plugin surfaces a one-time notice at load-time to remind you.

### 3. Local log file

**What:** plugin errors and debug output.
**Where:** `<your-vault>/.obsidian/plugins/github-data/errors.log` (rotating).
**Encryption:** none.
**Contents:** stack traces, HTTP status codes, sanitized request URLs (no PATs). Never transmitted anywhere.

### 4. Vault-native synced files

**What:** mirrored GitHub entities (repos, issues, PRs, releases, Dependabot alerts, activity summaries).
**Where:** `02_AREAS/GitHub/` and `99_ARCHIVE/github/` by default (configurable).
**Encryption:** whatever your vault provides (Obsidian Sync supports end-to-end encryption; iCloud / Dropbox do not by default).
**Contents:** markdown files with structured frontmatter. Issue / PR / README bodies are sanitized before write to neutralize HTML injections, Templater exec markers, and Dataview inline queries (see the plugin's Security Invariants).

Frontmatter shape per entity class is documented in the main design doc (will be published under `docs/design.md` at v0.1).

## Token rotation

If you migrate your PAT from plaintext to `SecretStorage`, **rotate the token in GitHub settings** -- the original value has already been written to `data.json` and may be retained in:

- Git history (if your vault is under version control)
- Obsidian Sync / iCloud / Dropbox history (30+ day retention typical)
- SSD wear-leveling / disk slack (indefinite)

The plugin cannot clean these up. Rotation is the only safe path.

## Retention caps

To prevent unbounded vault growth:

| Entity | Kept hot (in `02_AREAS/GitHub/`) | Archived (moved to `99_ARCHIVE/github/`) |
| :----- | :------------------------------- | :-------------------------------------- |
| Repo profile | Always | Never |
| Open issue | While open | 30-day grace after close |
| Open PR | While open | 30-day grace after close/merge |
| Release | Always | Never (archival artifacts) |
| Dependabot (open) | While open | On dismiss/fix |
| Commit | Never per-entity file | Aggregated into `Activity/YYYY-MM-DD.md` only |
| Notification | Never per-entity file | Rendered live in view; ephemeral |
| Workflow run | Never per-entity file | Aggregated; most-recent surfaced live |
