# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe changes from the perspective of someone installing or using
pi-tgrep — what changed for them, not how it was implemented internally.

## [Unreleased]

## [0.1.0] - 2026-09-16

### Added

- Auto-indexing of the enclosing git repo via a shared, file-watching `tgrep serve` daemon.
- A `grep` tool that transparently routes searches through the trigram index, with fallback
  to ripgrep when the index isn't ready yet.
- A shell policy hook that translates `grep`/`rg` shell commands (including inside pipelines)
  to `tgrep`, with `translate` / `block` / `warn` / `off` modes via `PI_TGREP_BASH_POLICY`.
- Graceful degradation when the `tgrep` binary is missing, with an optional one-time
  Homebrew install prompt (`PI_TGREP_AUTO_INSTALL`).
