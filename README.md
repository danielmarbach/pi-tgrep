# pi-tgrep

[tgrep](https://github.com/microsoft/tgrep) for [pi](https://pi.dev): auto-indexes your repo
with a trigram index and makes sure every search the LLM performs, whether through the `grep`
tool or through shell commands, runs on tgrep instead of scanning every file.

## Why

`grep` and `ripgrep` re-scan the whole tree on every query (O(total bytes) each time). On large
repos that is the slowest thing an agent does all day. tgrep keeps a trigram index with a
persistent, file-watching server and answers the same queries orders of magnitude faster,
while staying ripgrep-compatible (same flags, same `--json` events, same ignore rules).

pi's `grep` tool is the code-search path of least resistance for a model. pi-tgrep turns that
path into the fast one and closes the side doors.

## What it does

1. **Auto-index**: on `session_start` it finds the enclosing git repo and ensures a
   `tgrep serve` daemon is running for it (spawned detached, builds the index if missing, and
   the file watcher keeps it fresh). The server is shared across sessions and with other tgrep
   clients. `.tgrep/` is added to `.git/info/exclude` so `git status` stays clean.
2. **Owns the `grep` tool**: registers a tool named `grep` with the identical schema
   (`pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit`) and identical
   output contract. The model calls `grep` like always, but the results come from the trigram
   index. Every result carries `details.engine` for provenance, plus `details.fallback`
   (why ripgrep served the query: index still building, no binary, or error) and
   `details.truncated` when the match limit kicked in. When the repo index exists, searches
   under the repo root automatically pass `--index-path <index dir>`, because tgrep only looks
   for the index next to the searched path, so a subdirectory search would otherwise silently
   fall back to scanning every file.
3. **Guards the shell**: a `tool_call` hook inspects `bash` **and MCP shell-executing tools**
   (`ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, bare or namespaced like
   `mcp__context-mode__ctx_execute`, extend via `PI_TGREP_WATCH_TOOLS`), pipeline-aware:
   - commands are split on top-level `|`; each segment is judged on its primary binary;
   - grep/`rg` scan segments (pattern + path present) are transparently translated to
     `tgrep search` (the CLI's `search` subcommand — it answers from an existing index or
     scans directly, while the bare default query mode can hang when no server is running)
     with quote-preserving re-emission (`'foo|bar'` stays quoted, translated globs are always
     quoted, `sudo`/`env` prefixes survive);
   - translated bash commands are stamped onto the tool result (`details.engine: "tgrep"`
     plus the rewritten and original commands), so session logs and `npm run analyze`
     attribute shell tgrep usage directly;
   - the index directory is resolved for the directory the command actually runs in — the
     leading `cd` target when there is one, otherwise the session cwd — so
     `cd /other/repo && grep …` searches that repo's index, not the session repo's; when a
     valid index directory exists, translated commands whose positional paths are all
     relative get `--index-path '<index dir>'` injected (any absolute positional, or an
     explicit `--index-path`, skips the injection); without an index the `search` scans the
     files directly (tgrep prints its own notice) — a bare query-mode `tgrep`, which would
     rebuild an index beside the searched path or hang, is never emitted; `-e`/`--regexp`/
     `-f`/`--file` pattern arguments are tracked so a pattern never masquerades as a path;
   - grep/`rg` stdin post-filters (`… | grep -v x`) are left verbatim: no tree scan, no block;
   - `ctx_execute`/`ctx_execute_file` shell code is checked line by line; heredoc bodies are
     never rewritten, and inside heredoc-containing blocks family command lines block instead;
   - non-shell `ctx_execute`/`ctx_execute_file` code (e.g. JavaScript) is scanned for
     `child_process` exec/spawn calls (`exec`, `execSync`, `execFile`, `execFileSync`,
     `spawn`, `spawnSync`): an embedded shell grep inside a backtick template or
     double-quoted string is translated in place, while single-quoted, escaped, interpolated,
     or statically unextractable commands are blocked, so `execSync('grep -rn …')` can no
     longer bypass the index;
   - `ctx_batch_execute` entries are checked individually (the entry's label appears in block
     reasons);
   - output-side redirects are preserved with fd numbers still glued to their redirect
     (`2>/dev/null`, `2>>file`, `2>&1`), so the fd digit never leaks into tgrep as a search path;
   - `;`, `&&`, `||`, background `&`, backticks, `$()`, and stdin redirects (`<`) are blocked;
   - unknown flags are blocked with a reason that redirects the model to the `grep` tool;
     BRE-only patterns (`\(`, `\1`, …) and `ag`/`ack`/`pt` (flag semantics diverge from
     rg/tgrep) run the original command untranslated, exact but slow; under
     `PI_TGREP_BASH_POLICY=block` both are still blocked;
   - `zgrep`, `git log --grep`, and filenames containing "grep" are never touched.
4. **Degrades gracefully**: no tgrep binary means it is fully dormant (built-in grep untouched,
   with a one-time offer to `brew install tgrep`). Index still building falls back to ripgrep
   so results are never silently incomplete. Server dead falls back to tgrep's own on-disk
   index.

## Install

```bash
# from a local checkout
pi install /path/to/pi-tgrep

# from git
pi install git:github.com/danielmarbach/pi-tgrep

# from npm
pi install npm:@danielmarbach/pi-tgrep
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
| `PI_TGREP_AUTO_INSTALL` | `ask` | `ask` \| `never` \| `always`: brew install when tgrep is missing; `ask` prompts once and remembers (`~/.cache/pi-tgrep/auto-install.json`) |
| `PI_TGREP_BASH_POLICY` | `translate` | `translate` (translate scan segments in pipelines, block the rest) \| `block` (block all grep-family shell use) \| `warn` (allow, notify) \| `off` |
| `PI_TGREP_WATCH_TOOLS` | – | additional tool names to watch, comma-separated, additive to the default set (`bash`, `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`); names match bare or `namespace__name` |
| `PI_TGREP_SERVE_ARGS` | – | extra args passed to `tgrep serve` (e.g. `"--exclude vendor --no-watch"`); split on whitespace, quotes are not parsed, so individual args cannot contain spaces |
| `PI_TGREP_INDEX_PATH` | tgrep default (`<repo>/.tgrep`) | index directory override, honored everywhere: `serve`, `status`/stop/`reindex`, the grep tool, and shell injection; relative values resolve against the repo root |
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
                      re-emission, verbatim fallback or guided blocks for the rest
```

### Output parity

The override keeps pi's grep output contract byte-for-byte where it matters: `path:line: text`
matches, `path-line- ` context lines, `No matches found`, the `[N matches limit reached…]` and
truncation notices, and `details` fields (`matchLimitReached`, `truncation`, `linesTruncated`).
The only additions are metadata: `details.engine: "tgrep" | "rg-fallback"`,
`details.fallback: { reason: "indexing" | "no-binary" | "error", message? }`, and
`details.truncated`.

### Safety notes

- GNU grep's `-r` is **recursive**, but tgrep's `-r` is `--replace`, so the translator drops
  `-r/-R` instead of passing them through (tgrep walks recursively by default).
- Plain `grep` patterns using BRE-only syntax (`\(`, `\1`, …) are not translated. tgrep's
  default engine is a Rust regex (ERE-like), so a translation would silently match
  differently; the original command runs instead. `-E`/`egrep` need no flag; `-F`/`fgrep`
  maps to `-F`; `-P`/`--perl-regexp` maps to tgrep's `-P` (PCRE2).
- During a from-scratch index build the tgrep server answers from an empty index, so searches
  temporarily use ripgrep until `Indexing: complete`, favoring correctness over speed.

## Validation

```bash
npm run typecheck   # npx tsc --noEmit -p tsconfig.json
npm test            # node --test over harness.mjs + the *.test.mjs suites
```

The test suites shell out to the real `tgrep` binary (`brew install tgrep`), so they need it on
`PATH` locally and in CI (see `.github/workflows/ci.yml`, which runs on `macos-latest` for that
reason).

`node scripts/analyze-pi-sessions.mjs` (or `npm run analyze`) mines `~/.pi/agent/sessions/`
for the real numbers: indexed vs fallback vs builtin grep traffic, zero-result rate, latency
p50/p95, search→read conversion, and how often the shell policy translates or blocks.
Translated shell greps are identified by the `details.engine: "tgrep"` stamp the extension
adds to the bash tool result; sessions recorded before the stamp existed count translated
greps as plain grep/rg.

See `test/e2e.md` for headless `pi -p` scripts and `test/tgrep-cli-notes.md` for the verified
tgrep CLI ground truth this implementation relies on.

## License

MIT
