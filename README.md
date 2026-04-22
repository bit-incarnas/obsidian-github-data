# GitHub Data

Obsidian plugin that mirrors GitHub state -- repos, issues, pull requests, releases, Dependabot alerts, Actions runs, contribution activity -- into vault-native markdown files. **Pull-in only:** vault data stays in the vault; nothing leaves except GitHub API calls needed for the integration.

Built to make GitHub state queryable via [Dataview](https://github.com/blacksmithgu/obsidian-dataview), graph-integrated, and `Heatmap Calendar`-compatible.

> **Status:** pre-alpha scaffold. Not installable yet. See [Design](https://github.com/bit-incarnas/obsidian-github-data/blob/main/docs/design.md) (once published) for the spec.

## Safety posture

- **Read-only GitHub scopes** in v0.1 -- the plugin cannot write to your repos until a future release opts into specific write endpoints.
- **No telemetry.** No third-party error reporting, no usage analytics, no phone-home. Errors go to a local log file only.
- **Token storage** via Obsidian's `SecretStorage` API (Obsidian 1.11+) when available, with explicit migration from plaintext `data.json`. Migration warns that the original token must be rotated.
- **Body sanitation** neutralizes `<script>` / `<iframe>` / `javascript:` URLs, Templater exec markers, and Dataview inline queries in synced content -- protects against RCE via hostile issue bodies from other plugins that auto-execute markdown.
- **Path containment** rejects hostile `owner` / `repo` names that could traverse outside the designated output folders.

Full disclosure: [`docs/data-egress.md`](docs/data-egress.md) + [`docs/data-schema.md`](docs/data-schema.md).

## Development

Requires Node 22+ and npm 10+.

```bash
npm install       # also wires up the pre-push hook (see below)
npm run dev       # esbuild watch -> main.js
npm test          # jest
npm run build     # typecheck + production build
```

`npm install` runs a `prepare` script that sets `core.hooksPath` to `hooks/`, wiring up the `pre-push` hook that blocks direct pushes to `main`. The remote ruleset rejects such pushes anyway; the local hook just fails faster with a friendly reminder. Bypass with `git push --no-verify` (server still rejects).

Workflow:

```bash
git switch -c feature/<short-name>
# ...work...
git push -u origin HEAD
gh pr create --fill
# CI runs; merge when green
```

To install locally against a dev vault:
1. Symlink `.obsidian/plugins/github-data/` in your dev vault to this repo directory.
2. Or use [BRAT](https://github.com/TfTHacker/obsidian42-brat) once a beta tag is pushed.

## License

MIT. See [LICENSE](LICENSE).

Third-party code fragments incorporated into this plugin are tracked in [NOTICES](NOTICES) with their upstream licenses.
