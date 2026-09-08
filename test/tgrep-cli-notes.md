# tgrep CLI notes (M0 ground truth)

tgrep 1.0.4, macOS arm64 (brew bottle). Verified 2026-09-07 against a fixture repo
(`/tmp/tgrep-m0`: git repo, nested dirs, `.gitignore` with `target/` + `*.log`, hidden file).

## Lifecycle

- `tgrep serve <path>` does **not** self-daemonize: it runs in the foreground until killed.
  Spawning it detached (`spawn(..., {detached: true, stdio: "ignore"})` + `unref()`) works —
  the server keeps running after the parent exits.
- Second `serve` for the same index dir refuses: stderr
  `another tgrep server is already running for index directory \`<dir>\` (pid N, port M). Stop the existing server before starting a new one.`
  The existing server is untouched.
- **There is no `stop` subcommand** (subcommands: `index`, `serve`, `search`, `status`,
  `count-files`, `help`). Stopping = `kill <pid from serve.json>`.
- Kill the server → stale `serve.json` remains, but clients handle it: search prints
  `Server unreachable, falling back to local index` (stderr) and searches the on-disk index
  directly. Correct results, exit 0.
- No index + no server → direct scan with a stderr warning; results still correct.
- `tgrep status` has **two output shapes**:
  - server running:
    ```
    Server status for /path
      PID:        19350
      Port:       52531
      Files:      3
      Trigrams:   130
      Cache:      0/50000
      Watcher:    active
      Indexing:   complete
    ```
  - no server:
    ```
    Index status for /path
      Files:      3
      Trigrams:   130
      Created:    54s ago
      Updated:    54s ago
      Server:     not running
    ```

## On-disk layout

Default index location: `<root>/.tgrep/` containing `lookup.bin`, `index.bin`, `files.bin`,
`files-extra.bin`, `meta.json`, `filestamps.json`, `serve.json`, `serve.lock`.
`serve.json` = `{"pid":19350,"port":52531}` — trivially parseable, viable as the primary
server-discovery source (with `kill(pid, 0)` liveness check) per the plan's defensive parsing.

**Decision:** keep tgrep's native `.tgrep` index location (no `--index-path` by default).
Rationale: server discovery is shared with any other tgrep client on the same repo (e.g.
Copilot CLI); a custom cache-dir path would fork server discovery and risk two servers per
repo. `.tgrep/` is never self-indexed (hidden dirs are excluded by default, `-.`/`--hidden`
opts in). To keep `git status` clean, the plugin appends `.tgrep/` to `.git/info/exclude`
(local-only, does not touch tracked files). `PI_TGREP_INDEX_PATH` overrides via `--index-path`.

**Decision:** server-readiness gating uses the `Indexing:` field from `status` (server shape).
During a from-scratch build the server answers from an empty index (per README; not directly
observable on a tiny fixture), so the grep override falls back to ripgrep until
`Indexing: complete`.

## Search behavior

- `--json` emits **ripgrep's event schema**: `begin` / `match` / `context` / `end` / `summary`
  lines with `data.path.text`, `data.line_number`, `data.lines.text`,
  `data.submatches[{start,end,match.text}]`, `data.binary_offset`, per-event `stats`.
  Context events carry `submatches: []`.
- Exit codes: **0** match, **1** no match, **2** error (e.g. `(unclosed` regex).
- Hidden files excluded by default (`--hidden` / `-.` to include). `.gitignore` respected
  (fixture: `*.log` and `target/` excluded → Files: 3).
- `-m N` = max matches **per file** (same as rg).
- Verified flags: `-C`, `-g`, `-i`, `-F`, `-m`, `-l`, `-c`, `--sort path`, `--hidden`,
  `--json`, `--vimgrep` (listed), `-A/-B` (listed), `--no-ignore`, `--no-index` (listed),
  `-j`, `--stats`.
- ⚠️ **`-r` is `--replace <TEXT>` in tgrep, not recursive.** GNU grep's `-r/-R` must be
  *dropped* (never passed through) when translating grep → tgrep; tgrep walks recursively by
  default.
- `tgrep count-files <path>` prints a fast walker count (first line) + human summary — useful
  as a cheap "is this repo big enough to matter" gate.
- Server mode searches report `bytes_searched: 0` in stats (index hit); direct scans report
  real bytes. Usable as a heuristic for "did this go through the index".
