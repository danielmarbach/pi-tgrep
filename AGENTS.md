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

## Shell command handling has several entry points

Shell syntax is parsed in more than one place. A change to how commands are scanned (heredocs,
here-strings, quoting, redirects, separators, `cd`) usually has to be applied to all of them, or
one tool behaves differently from the others.

| Entry point | Tool | Parsing |
| --- | --- | --- |
| `applyBashPolicy` in `src/bash-policy.ts` | `bash`, custom watched tools, each `ctx_batch_execute` command, and every command the paths below hand it | `scanPipeline` splits the whole command; this is the real shell scanner |
| `applyToShellCode` in `src/watched-tools.ts` | `ctx_execute` / `ctx_execute_file` with `language: "shell"` | Splits on newlines itself and tracks heredoc bodies with its own `HEREDOC_MARKER` before calling `applyBashPolicy` per line |
| `applyJsChildProcessGuard` in `src/watched-tools.ts` | `ctx_execute` / `ctx_execute_file` with other languages | Extracts the string passed to `exec`/`spawn`, then calls `applyBashPolicy` on it |

When touching any of these:

- Check whether the same rule exists in the others (`HEREDOC_MARKER` and `scanPipeline` both
  decide what a heredoc is and must agree on `<<`, `<<-` and `<<<`).
- Add a test per entry point: `test/bash-blocks.test.mjs` for `applyBashPolicy`,
  `test/harness.mjs` for `applyToolCallPolicy` (`bash`, `ctx_execute`, `ctx_batch_execute`), and
  `test/js-guard.test.mjs` for the JavaScript guard.
- Update the matching README bullet, which documents the per-tool behavior.
