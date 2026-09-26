# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe changes from the perspective of someone installing or using
pi-tgrep — what changed for them, not how it was implemented internally.

## [Unreleased]

## [0.3.0] - 2026-09-26

### Fixed

- A translated shell grep with an empty pattern (`grep -c "" file`, often used to count lines)
  no longer loses the pattern. Before, the file name became the pattern and the command printed
  nothing.
- Unquoted globs, `~` and brace expansions in translated shell greps (`grep -n foo src/*.ts`)
  expand again. Before, they reached tgrep as literal text and failed with an IO error.
- Shell greps over a variable or command substitution (`grep -n foo "$f"`, `grep -rn "$PAT" src`)
  no longer search for the literal text `$f`/`$PAT`. They now run unchanged.
- JavaScript run through `ctx_execute` is no longer blocked just for calling `RegExp.exec` (or any
  other `.exec`/`.spawn` method that isn't `child_process`). Unextractable `child_process` calls
  are now only blocked when the code mentions grep at all.

### Changed

- When a translated shell grep fails or prints nothing, the tool result now shows which
  `tgrep search` command ran in place of the original, so the model can tell a real empty
  result from a translation problem instead of assuming grep is blocked.
- Shell greps over `$(…)`, backtick or `$var` file lists, and commands behind a dynamic
  `cd "$DIR" && …`, now run unchanged instead of being blocked. A grep nested inside `$(…)`
  or backticks is still blocked.
- `a || grep …` is split and translated like `&&` instead of being blocked.
- Block messages now say what triggered them (for example command substitution, stdin
  redirect, or the specific unsupported flag) and mention that piping into grep runs unchanged.

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
