# pi-tgrep

[tgrep](https://github.com/microsoft/tgrep) for [pi](https://pi.dev): auto-indexes your repo
with a trigram index and makes sure every search the LLM performs — through the `grep` tool or
through shell commands — runs on tgrep instead of scanning every file.

## Why

`grep` and `ripgrep` re-scan the whole tree on every query — O(total bytes) each time. On large
repos that is the slowest thing an agent does all day. tgrep keeps a trigram index with a
persistent, file-watching server and answers the same queries orders of magnitude faster,
while staying ripgrep-compatible (same flags, same `--json` events, same ignore rules).

pi's `grep` tool is the code-search path of least resistance for a model. pi-tgrep turns that
path into the fast one and closes the side doors.

## What it does

1. **Auto-index** — on `session_start` it finds the enclosing git repo and ensures a
   `tgrep serve` daemon is running for it (spawned detached; builds the index if missing; the
   file watcher keeps it fresh). The server is shared across sessions and with other tgrep
   clients. `.tgrep/` is added to `.git/info/exclude` so `git status` stays clean.
2. **Owns the `grep` tool** — registers a tool named `grep` with the identical schema
   (`pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit`) and identical
   output contract. The model calls `grep` like always; the results come from the trigram
   index. Every result carries `details.engine` for provenance.
3. **Guards the shell** — a `tool_call` hook inspects `bash` invocations:
   - single `rg`/`grep`/`egrep`/`fgrep` commands are transparently rewritten to `tgrep`
     (`sudo`/`env` prefixes preserved, GNU flags translated);
   - pipes, redirects, `$()`, unknown flags, and BRE-only patterns are blocked with a reason
     that redirects the model to the `grep` tool;
   - `zgrep`, `git log --grep`, and filenames containing "grep" are never touched.
4. **Degrades gracefully** — no tgrep binary → fully dormant (built-in grep untouched, with a
   one-time offer to `brew install tgrep`). Index still building → falls back to ripgrep so
   results are never silently incomplete. Server dead → tgrep itself falls back to the
   on-disk index.

## Install

```bash
# from a local checkout
pi install /path/to/pi-tgrep

# from git
pi install git:github.com/<owner>/pi-tgrep

# from npm (once published)
pi install npm:pi-tgrep
```

Requires the `tgrep` binary (`brew install tgrep`, or cargo from the tgrep repo). If it is
missing, pi-tgrep offers to install it via Homebrew once (see `PI_TGREP_AUTO_INSTALL`).

For development, skip the install and load it directly:

```bash
pi -e /path/to/pi-tgrep/extensions
```

## Configuration

All configuration is via environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PI_TGREP_DISABLED` | – | `1` disables the extension entirely |
| `PI_TGREP_AUTO_INSTALL` | `ask` | `ask` \| `never` \| `always` — brew install when tgrep is missing; `ask` prompts once and remembers (`~/.cache/pi-tgrep/auto-install.json`) |
| `PI_TGREP_BASH_POLICY` | `translate` | `translate` (rewrite simple commands, block the rest) \| `block` (block all grep-family shell use) \| `warn` (allow, notify) \| `off` |
| `PI_TGREP_SERVE_ARGS` | – | extra args passed to `tgrep serve` (e.g. `"--exclude vendor --no-watch"`); split on whitespace — quotes are not parsed, so individual args cannot contain spaces |
| `PI_TGREP_INDEX_PATH` | tgrep default (`<repo>/.tgrep`) | forwarded as `--index-path` |
| `PI_TGREP_SCOPE` | `repo` | `repo` keeps the server after the session ends; `session` stops servers this session started on shutdown |

## Commands

| Command | Action |
|---|---|
| `/tgrep-status` | show server/index status for the current repo |
| `/tgrep-reindex` | stop the server, rebuild the index, restart |
| `/tgrep-stop` | stop the server for this repo |

The footer shows `tgrep: N files` (or `tgrep: indexing…`) while active.

## Architecture

```
extensions/index.ts   factory: config → binary check → session lifecycle → hooks → commands
src/config.ts         env-var parsing
src/tgrep-client.ts   binary discovery, status parsing (both output shapes), serve.json
                      discovery + PID liveness, stop (SIGTERM→SIGKILL; tgrep has no stop cmd)
src/server-manager.ts repo-root detection, detached `tgrep serve` spawn, .git/info/exclude
                      maintenance, readiness monitor, per-scope shutdown, reindex
src/grep-tool.ts      the grep override: TypeBox schema identical to the built-in, tgrep
                      --json streaming (ripgrep event schema, parsed 1:1), built-in truncation
                      rules via pi's own helpers, abort handling, rg fallback while indexing
src/bash-policy.ts    shell detection (quote-aware), rg→tgrep pass-through, grep→tgrep flag
                      translator, conservative block-with-guidance ladder
```

### Output parity

The override keeps pi's grep output contract byte-for-byte where it matters: `path:line: text`
matches, `path-line- ` context lines, `No matches found`, the `[N matches limit reached…]` and
truncation notices, and `details` fields (`matchLimitReached`, `truncation`, `linesTruncated`).
The only additions: `details.engine: "tgrep" | "rg-fallback"`.

### Safety notes

- GNU grep's `-r` is **recursive**, but tgrep's `-r` is `--replace` — the translator drops
  `-r/-R` instead of passing them through (tgrep walks recursively by default).
- Plain `grep` patterns using BRE-only syntax (`\(`, `\1`, …) are blocked, not mistranslated;
  tgrep's default engine is a Rust regex (ERE-like). `-E`/`egrep` need no flag; `-F`/`fgrep`
  maps to `-F`.
- During a from-scratch index build the tgrep server answers from an empty index, so searches
  temporarily use ripgrep until `Indexing: complete` — correctness over speed.

## Validation

```bash
npx tsc --noEmit -p tsconfig.json   # types
node test/harness.mjs               # component + lifecycle tests (no provider needed)
```

See `test/e2e.md` for headless `pi -p` scripts and `test/tgrep-cli-notes.md` for the verified
tgrep CLI ground truth this implementation relies on.

## License

MIT
