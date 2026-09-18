# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe changes from the perspective of someone installing or using
pi-tgrep — what changed for them, not how it was implemented internally.

## [Unreleased]

## [0.2.3] - 2026-09-18

### Fixed

- Shell `grep`/`rg` commands are now translated to `tgrep search` instead of the bare default
  query mode, which could hang indefinitely and spawn an orphaned server when no tgrep server
  was running for the searched directory.
- A translated command now uses the index of the directory it actually runs in (the leading
  `cd` target when present), so `cd /other/repo && grep …` searches that repo's index rather
  than the session repo's.
- When the searched directory has no index yet (for example during the initial index
  build), the translated `tgrep search` scans the files directly instead of rebuilding an
  index beside the searched path, so the very first search of a session still works.

## [0.2.2] - 2026-09-16

### Fixed

- Compound shell commands joined with `&&` or `;` that contain a `grep`/`rg` call no longer
  block the entire command. Only the search part is rewritten to use the tgrep index and the
  rest of the command runs unchanged. The whole command is still blocked when its search part
  cannot be translated, or when it uses command substitution, backticks, background `&`, or
  input redirection.

## [0.2.1] - 2026-09-16

### Fixed

- Shell `grep`/`rg` commands that use backslash escapes (for example `\b`, `\d`, `\.`) are
  rewritten to `tgrep` with the pattern preserved, instead of being corrupted into a pattern
  that matched nothing.
- The message shown when a shell search is blocked now points at the index-backed `grep` tool
  and tells you to pass `--index-path` when running `tgrep` yourself, instead of suggesting a
  bare `tgrep` run that only looks for the index next to the searched path.

## [0.2.0] - 2026-09-16

### Changed

- npm installs now carry only what runs: the extension, its sources, README, changelog, and
  license. Test fixtures and CI workflow files are no longer downloaded with the package.

## [0.1.0] - 2026-09-16

### Added

- Auto-indexing of the enclosing git repo via a shared, file-watching `tgrep serve` daemon.
- A `grep` tool that transparently routes searches through the trigram index, with fallback
  to ripgrep when the index isn't ready yet.
- A shell policy hook that translates `grep`/`rg` shell commands (including inside pipelines)
  to `tgrep`, with `translate` / `block` / `warn` / `off` modes via `PI_TGREP_BASH_POLICY`.
- Graceful degradation when the `tgrep` binary is missing, with an optional one-time
  Homebrew install prompt (`PI_TGREP_AUTO_INSTALL`).
