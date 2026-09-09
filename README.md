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
   index. Every result carries `details.engine` for provenance. When the repo index
   (`<repo>/.tgrep`) exists, searches under the repo root automatically pass
   `--index-path <repo>/.tgrep` — tgrep only looks for the index next to the searched path,
   so a subdirectory search would otherwise silently fall back to scanning every file.
3. **Guards the shell** — a `tool_call` hook inspects `bash` **and MCP shell-executing tools**
   (`ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` — bare or namespaced like
   `mcp__context-mode__ctx_execute`; extend via `PI_TGREP_WATCH_TOOLS`), pipeline-aware:
   - commands are split on top-level `|`; each segment is judged on its primary binary;
   - grep/`rg` scan segments (pattern + path present) are transparently translated to `tgrep`
     with quote-preserving re-emission (`'foo|bar'` stays quoted, translated globs are always
     quoted, `sudo`/`env` prefixes survive);
   - when the repo index (`<repo>/.tgrep`) exists, translated commands whose positional paths
     are all relative get `--index-path '<repo>/.tgrep'` injected (any absolute positional —
     or an explicit `--index-path` — skips the injection);
   - grep/`rg` stdin post-filters (`… | grep -v x`) are left verbatim — no tree scan, no block;
   - `ctx_execute`/`ctx_execute_file` shell code is checked line by line; heredoc bodies are
     never rewritten, and inside heredoc-containing blocks family command lines block instead;
   - non-shell `ctx_execute`/`ctx_execute_file` code (e.g. JavaScript) is scanned for
     `child_process` exec/spawn calls (`exec`, `execSync`, `execFile`, `execFileSync`,
     `spawn`, `spawnSync`): an embedded shell grep inside a backtick template or
     double-quoted string is translated in place, while single-quoted, escaped, interpolated,
     or statically unextractable commands are blocked — `execSync('grep -rn …')` can no
     longer bypass the index;
   - `ctx_batch_execute` entries are checked individually (the entry's label appears in block
     reasons);
   - output-side redirects are preserved with fd numbers still glued to their redirect
     (`2>/dev/null`, `2>>file`, `2>&1`) — the fd digit never leaks into tgrep as a search path;
   - `;`, `&&`, `||`, background `&`, backticks, `$()`, and stdin redirects (`<`) are blocked;
   - unknown flags, BRE-only patterns, and `ag`/`ack`/`pt` are blocked with a reason that
     redirects the model to the `grep` tool;
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
| `PI_TGREP_BASH_POLICY` | `translate` | `translate` (translate scan segments in pipelines, block the rest) \| `block` (block all grep-family shell use) \| `warn` (allow, notify) \| `off` |
| `PI_TGREP_WATCH_TOOLS` | – | additional tool names to watch, comma-separated, additive to the default set (`bash`, `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`); names match bare or `namespace__name` |
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
src/bash-policy.ts    shell detection (quote-aware), pipeline segmentation, rg→tgrep
                      pass-through, grep→tgrep flag translator with quote-preserving
                      re-emission, block-with-guidance for the rest
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
