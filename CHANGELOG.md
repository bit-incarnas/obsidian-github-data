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

### Data egress
- **No outbound network calls yet.** Plugin currently only registers a `GitHub Data: Ping` command that prints to console. No HTTP layer implemented.
