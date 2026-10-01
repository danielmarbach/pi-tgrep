# Agent Instructions

Instructions for AI coding agents (and contributors) working in this repository.

## Changelog

This project keeps a [`CHANGELOG.md`](./CHANGELOG.md) following the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

- **Always update `CHANGELOG.md` under `[Unreleased]`** when a change affects users of the
  pi-tgrep extension: new features, behavior changes, configuration changes, bug fixes, or
  removals.
- **Always focus on the user-facing parts.** Describe what changed for someone installing or
  using pi-tgrep (new tool behavior, a new environment variable, a fixed bug a user could hit,
  a changed default) — not internal refactors, implementation details, or test-only changes.
  Skip the changelog entry entirely for changes that have no observable effect on users.
- Use the existing `Added` / `Changed` / `Fixed` / `Removed` subsections under `[Unreleased]`,
  creating them as needed.
- Keep entries under `[Unreleased]` for ordinary changes; do not invent a version heading for
  them. Cutting a release moves them under a new dated heading — see Releasing.

## Releasing

Nothing cuts the changelog automatically, so prepare the release by hand:

1. Bump `version` in `package.json` and in `package-lock.json` (both the top-level field and
   `packages[""].version`).
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD`
   heading, leaving `[Unreleased]` empty at the top.
3. Commit, then push a `vx.y.z` tag that matches the version.

Pushing the tag triggers [`.github/workflows/publish.yml`](./.github/workflows/publish.yml),
which verifies the tag matches `package.json`, runs typecheck/tests, publishes to npm, creates a
GitHub release from the matching `CHANGELOG.md` section, and closes the milestone titled `vx.y.z`.

## Shell command handling

Shell syntax (quoting, heredocs, here-strings, redirects, separators, comments, `cd`) is parsed in
exactly one place: `scanPipeline` and `applyBashPolicy` in `src/bash-policy.ts`. Every watched tool
goes through it, so a scanning change applies to all of them:

- `bash`, custom watched tools, and each `ctx_batch_execute` command pass the command as is.
- `ctx_execute` / `ctx_execute_file` with `language: "shell"` pass the whole script. Newlines are
  command separators, so a script is not scanned line by line.
- `ctx_execute` / `ctx_execute_file` in other languages go through `applyJsChildProcessGuard`
  in `src/watched-tools.ts`, which only extracts the string given to `exec`/`spawn` and hands it
  to `applyBashPolicy`.

Do not add a second shell parser in `watched-tools.ts`. Test a scanning change in
`test/bash-blocks.test.mjs`, and test a tool-specific change through `applyToolCallPolicy` in
`test/harness.mjs` or `test/js-guard.test.mjs`. The README documents the per-tool behavior.
