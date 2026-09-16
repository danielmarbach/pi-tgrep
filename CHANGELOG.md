# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe changes from the perspective of someone installing or using
pi-tgrep — what changed for them, not how it was implemented internally.

## [Unreleased]

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
