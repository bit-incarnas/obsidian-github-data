# Data Egress

User-facing disclosure of what data leaves your machine when this plugin runs. Matches the binding [data-egress policy](https://github.com/bit-incarnas/obsidian-github-data/blob/main/docs/policy/data-egress.md) of the plugin program.

**Principle:** vault data stays in the vault. This plugin pulls data *in* from GitHub; it does not push vault contents *out* except when an explicit user-invoked command (in a future phase) requests it.

## Scaffold (v0.0.1) -- current state

| Outbound call | Destination | Trigger | Payload | Notes |
| :------------ | :---------- | :------ | :------ | :---- |
| *(none)* | -- | -- | -- | The plugin has no HTTP layer yet. The only registered command is a console-only smoke test. |

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
