# pi-tgrep — Implementation Plan

A pi package that makes [microsoft/tgrep](https://github.com/microsoft/tgrep) the default code-search
engine for every pi session in a repo: it auto-indexes the repo on session start and guarantees that
any grep-shaped work the LLM does — via the `grep` tool or via shell commands — goes through tgrep
instead of a full tree scan.

## Status: COMPLETE (2026-09-08)

All milestones M0–M4 done, skill-reviewed (typescript-code-review), all 13 review findings fixed,
typecheck + harness green (19 policy cases, 8 grep-tool cases, server-manager lifecycle). Code is
uncommitted in this repo; install with `pi install /path/to/repo` or run with `pi -e ./extensions`.

### M0 ground truth that changed the plan

- `tgrep serve` is **foreground-only** → plugin spawns it detached; a second `serve` on the same
  index dir refuses (safe to re-ensure).
- **No `stop` subcommand** → `/tgrep-stop` SIGTERM→SIGKILLs the PID from `serve.json` (verified
  to be tgrep via `ps` before killing).
- Index lives in `<repo>/.tgrep/` — **kept native** (not moved to a cache dir) so server discovery
  stays shared with other tgrep clients (e.g. Copilot CLI); `.git/info/exclude` gets `.tgrep/`.
- `--json` is ripgrep's event schema → the override parses it 1:1 like the built-in does.
- **`-r` is `--replace` in tgrep**, not recursive — GNU grep `-r/-R` are dropped in translation.
- Exit codes 0/1/2 (match/no-match/error); dead server → clients auto-fall back to the on-disk
  index.

### Deviations from the original plan

- No persistent extension-state API in pi → auto-install decision persisted in
  `~/.cache/pi-tgrep/auto-install.json`.
- `repoRoot` returns `null` outside a git repo → session skips server management entirely
  (replaces the planned `PI_TGREP_MIN_FILES` gate, which was dropped).
- rg fallback delegates to `createGrepToolDefinition` from the pi package (same rg
  resolution/download as the built-in) instead of spawning bare `rg`.
- Review fix C1 took the conservative branch: any shell command with a quoted token is **blocked**
  (redirect to the grep tool), never re-emitted unquoted — `'foo|bar'` can't become a pipe.
- `grep -P` / `rg -P` block (tgrep has no `-P`; it's `--engine pcre2`).
- Imports use `.ts` specifiers (`allowImportingTsExtensions`) for jiti compatibility.
- `test/fixtures/repo` ships as **plain files** (no nested `.git`, no generated `.tgrep/`); the
  harness `git init`s a temp copy so gitignore-respect and server-lifecycle assertions still run
  against a real repo without committing a nested repository or binary artifacts.

### Known residual gaps

- rg-fallback engine path validated by code review + status gating only, never observed live
  (tiny fixture repos index in milliseconds).
- `pi install ./` smoke test skipped to avoid mutating user settings.
- `user_bash` interception (user-typed commands) remains phase 2.
- `ag`/`ack`/`pt` are detected but always blocked, never translated.
- `PI_TGREP_SERVE_ARGS` splits on whitespace — quoted values unsupported (documented in README).

## 1. Goals

- **Auto-index**: when a session starts in a repo, ensure a tgrep server is running for it
  (index built or building, file watcher active) with zero user action.
- **Enforce tgrep**: every code search the LLM performs uses tgrep:
  - the built-in `grep` tool is *overridden* with a tgrep-backed implementation (same name, same
    parameters — the model doesn't have to learn anything new);
  - `grep`/`rg`/`ag`/`ack` invocations in `bash` tool calls are translated to `tgrep`, or blocked
    with a redirect message when translation isn't safe.
- **Degrade gracefully**: no tgrep binary → built-in behavior untouched. Index still building →
  temporary ripgrep fallback so results are never silently incomplete.
- **Zero-friction distribution**: installable via `pi install` (npm/git/local path).

### Non-goals (v1)

- Overriding the `find` tool (tgrep's filename sidecar makes this possible later).
- Windows / PowerShell interception.
- Index management UI beyond a few slash commands and a footer status.

## 2. Background

### tgrep (verified from README)

- Trigram-indexed grep, ripgrep-compatible CLI. `tgrep index .` builds the index;
  `tgrep serve .` starts a TCP JSON-RPC server that **watches for file changes** and
  **auto-builds the index if missing**; `tgrep <pattern> .` auto-connects to a running server
  (discovery via `serve.json` containing PID + port) and falls back to direct index search.
- `tgrep status` reports PID, port, file/trigram counts, watcher state, and
  `Indexing: complete|…`.
- Flags we rely on: `--json` (JSON lines with `lines.text` + submatch offsets), `-i`, `-F`,
  `-g/--iglob`, `-n/-N`, `-l`, `-c`, `-A/-B/-C`, `-m`, `--sort`, `--exclude`, `--index-path`,
  `--no-watch`, `-j`. Ignore handling mirrors ripgrep (`.gitignore`, `.ignore`, exclude files).
- Caveat: a server building an index **from scratch** answers from an *empty* index until the
  build finishes → we must not serve LLM searches from it during that window.
- Install: `brew install tgrep` (also cargo / release assets).

### pi extension API (verified, pi 0.85.1, pi.dev/docs/latest/extensions)

- Extensions are TypeScript modules (jiti, no build step). Factory: `export default (pi: ExtensionAPI) => …`.
- **Override built-ins**: `pi.registerTool()` with `name: "grep"` replaces the built-in grep tool.
  Omitted `renderCall`/`renderResult` automatically inherit the built-in renderers;
  `promptSnippet`/`promptGuidelines` are **not** inherited and must be redefined.
- **Intercept tool calls**: `pi.on("tool_call")` fires before execution; `event.input` is mutable
  in place (patch bash `command` before it runs); return `{ block: true, reason }` to veto with a
  message the model sees.
- `pi.on("user_bash")` for user-typed shell commands (phase 2, optional).
- Lifecycle: don't start background resources in the factory — defer to `session_start`, clean up
  in `session_shutdown`. `pi.registerTool` inside `session_start` is supported and refreshes
  immediately.
- `pi.exec(cmd, args, { signal, timeout })`, `ctx.ui.notify/confirm/setStatus`,
  `pi.registerCommand`, `ctx.cwd` (per-session, respects session switching).
- Built-in grep schema we must stay compatible with:
  `pattern`, `path?`, `glob?`, `ignoreCase?`, `literal?`, `context?`, `limit?` (default 100
  matches, output `path:line:text`, truncated).
- Packages: `package.json` with `pi` manifest + `pi-package` keyword; pi core imports go in
  `peerDependencies` with `"*"`. `pi install npm:… | git:… | ./local-path`.

## 3. Architecture

```
pi session start (cwd = repo)
   │
   ├─ session_start handler
   │    ├─ resolve config (env vars)
   │    ├─ binary check: tgrep on PATH?  ──no──► dormant mode (built-in rg grep stays)
   │    ├─ optional bootstrap: brew install tgrep (behind one-time ui.confirm)
   │    ├─ ServerManager.ensureRunning(cwd)
   │    │     ├─ tgrep status → healthy? done
   │    │     └─ else spawn detached: tgrep serve . [--exclude …] [--index-path …]
   │    ├─ register grep tool override (tgrep-backed, rg fallback during build)
   │    └─ footer status: "tgrep: 12,345 files · watcher active"
   │
   ├─ LLM calls grep tool ──► tgrep --json … → same output contract as built-in
   │
   ├─ LLM calls bash with "rg -n foo src/" ──► tool_call handler rewrites to
   │        "tgrep -n foo src/"  (or blocks: "use the grep tool")
   │
   └─ session_shutdown ──► (repo scope: server stays; session scope: tgrep stop)
```

## 4. Component design

### 4.1 `src/config.ts`

| Env var | Default | Meaning |
|---|---|---|
| `PI_TGREP_DISABLED` | – | `1` disables everything |
| `PI_TGREP_AUTO_INSTALL` | `ask` | `ask` \| `never` \| `always` (brew only, one-time confirm; decision persisted) |
| `PI_TGREP_BASH_POLICY` | `translate` | `translate` (rewrite simple, block complex) \| `block` \| `warn` \| `off` |
| `PI_TGREP_SERVE_ARGS` | – | extra args for `tgrep serve` (e.g. `--exclude vendor`) |
| `PI_TGREP_INDEX_PATH` | tgrep default | forwarded as `--index-path` |
| `PI_TGREP_SCOPE` | `repo` | `repo` = server outlives the session; `session` = stop on shutdown |

### 4.2 `src/tgrep-client.ts` — binary + process plumbing

- `findBinary()`: `which tgrep` via `pi.exec`; memoized per process.
- `run(pattern, args, { signal })`: `pi.exec("tgrep", ["--json", …args, "--", pattern, path])`.
- `status(cwd)`: parse `tgrep status` (human text) → `{ running, pid, port, files, indexing }`.
  If the text format proves unstable, fall back to reading `serve.json` + PID liveness check.
- `waitFor readiness()`: poll status until `Indexing: complete` or timeout; expose progress for
  the footer.

### 4.3 `src/server-manager.ts` — auto-index lifecycle

- `ensureRunning(cwd)`:
  1. `status()` healthy → reuse (multiple pi sessions and Copilot CLI share one server — that's
     tgrep's design).
  2. Otherwise spawn `tgrep serve .` **detached** (`spawn(..., { detached: true, stdio: "ignore" }),
     unref()`) so it survives pi regardless of whether tgrep self-daemonizes; poll until
     `serve.json`/`status` confirms it's up.
- Only runs where it makes sense: a git repo root (walk up from `ctx.cwd`) or any directory with ≥
  `PI_TGREP_MIN_FILES` files (default: always). Never inside the index/ cache dir itself.
- Footer via `ctx.ui.setStatus("tgrep", …)`: `tgrep: indexing 45%` → `tgrep: 12,345 files`.
- Idempotent across `session_start` fires (`/new`, `/resume`, forks).
- `session_shutdown`: repo scope → leave server running; session scope → kill recorded PID.
- Re-index safety: watcher keeps the index fresh; `/tgrep-reindex` command runs `tgrep index .`
  for a full rebuild.

### 4.4 `src/grep-tool.ts` — the override (primary enforcement)

Register a tool named `grep` with the **identical schema** to the built-in
(`pattern`, `path?`, `glob?`, `ignoreCase?`, `literal?`, `context?`, `limit?`) and identical
output contract, so the model experiences zero change:

| Param | tgrep mapping |
|---|---|
| `pattern` | positional after `--` |
| `path` | resolved against `ctx.cwd` (same as built-in) |
| `glob` | `-g <glob>` |
| `ignoreCase` | `-i` |
| `literal` | `-F` |
| `context` | `-C <n>` |
| `limit` | stream JSON, stop and kill child after N matches (mirror built-in truncation) |

- Parse `--json` lines → format as `path:line:text` with the same truncation rules (long lines
  truncated, head-truncation for huge outputs).
- Omit `renderCall`/`renderResult` → built-in grep renderers are inherited for free.
- Re-define `promptSnippet` ("Search file contents via tgrep trigram index (fast on large repos)")
  and `promptGuidelines` (["Use grep for code search; it is tgrep-backed and indexed. Do not run
  grep/rg in bash — the grep tool is faster."]) since overrides don't inherit them.
- Mark provenance in `details` (`{ engine: "tgrep" \| "rg-fallback" }`) for testing/debugging.
- **Fallback ladder**: binary missing → don't register (built-in stays). Server down → one
  detached-serve retry, then client-side index search (still tgrep). Index still building →
  temporary rg execution with identical output shaping so results are complete.
- Abort support: kill the tgrep child on `signal` abort, same as built-in does with rg.

### 4.5 `src/bash-policy.ts` — shell interception (secondary enforcement)

`pi.on("tool_call")` for `toolName === "bash"`:

1. Split the command into pipeline segments on top-level `|` only (quote-aware). Still block on
   `;`, `&&`, `||`, `&`, backticks, `$()`, and `<` (stdin redirect). Output-side redirects
   (`2>/dev/null`, `>file`, `>>file`, `2>&1`) are safe and stay attached to their segment verbatim.
2. Per segment: tokenize (quote-tracking), strip `env`/`sudo` prefixes, identify the primary
   binary:
   - grep-family primary with ≥2 positionals (pattern + path(s)) = tree scan → translate that
     segment with the flag translator; translation failure blocks the whole command.
   - grep-family primary with ≤1 positional (pattern only, reads stdin) = post-filter → keep the
     segment verbatim (`rg --files` is the exception: always a scan → translate).
   - `tgrep` or non-family primary → verbatim. `ag`/`ack`/`pt` always block (they scan regardless
     of stdin and have no translation table).
3. Reassemble segments joined with ` | `. If no segment changed, allow the original unchanged.
   Config policies: `translate` (default, above), `block` (block whenever a grep-family primary
   appears in any segment), `warn` (allow + notify), `off`.
4. Rewrites preserve shell semantics via quote-preserving re-emission: tokens containing
   whitespace or `|&;<>()$\`*"'?[]{}~#` are single-quoted (`'` as `'\''`); translated globs
   (`--include=…` → `-g '…'`) are always quoted; bare-safe tokens stay bare; `sudo`/`env`
   prefixes re-emit bare. A quoted `'foo|bar'` can never become a bare `foo|bar`.
5. Never touch commands that merely *contain* the word grep (e.g. `zgrep`, filenames,
   `--grep=…` git log flags stay allowed; git log --grep uses its own engine and isn't a tree scan).

Phase 2 (optional): same translation in `pi.on("user_bash")` for user-typed `:!` commands.

### 4.6 Commands & UI

- `/tgrep-status` — notify server status snapshot.
- `/tgrep-reindex` — full rebuild.
- `/tgrep-stop` — stop the server for this repo.
- Footer status line while indexing/active.

### 4.7 Entry point `extensions/index.ts`

Factory wires: config → binary check → `session_start` (ensure server, register override, footer)
→ `tool_call` bash policy → commands → `session_shutdown`. No background work in the factory
itself.

## 5. Correctness & fallback matrix

| Situation | Behavior |
|---|---|
| tgrep on PATH, server healthy | grep tool + bash rewrites use tgrep |
| tgrep missing, auto-install declined | Extension dormant; built-in rg grep untouched |
| Server starting, index building | rg fallback for search correctness; footer shows progress |
| Watcher lag right after edit/write | Acceptable (ms-scale); `/tgrep-reindex` as escape hatch |
| tgrep run fails (bad regex, flags) | Surface error to model verbatim (same as rg errors today) |

## 6. Repo layout

```
pi-tgrep/
├── package.json          # pi manifest: { "pi": { "extensions": ["./extensions"] } }, keyword "pi-package"
├── tsconfig.json
├── extensions/
│   └── index.ts          # factory entry
├── src/
│   ├── config.ts
│   ├── tgrep-client.ts
│   ├── server-manager.ts
│   ├── grep-tool.ts
│   └── bash-policy.ts
├── test/
│   ├── fixtures/repo/    # small git repo fixture
│   └── e2e.md            # scripted headless-pi prompts + expected outcomes
├── README.md
└── PLAN.md
```

Dev workflow: `pi -e ./extensions` (or symlink into `~/.pi/agent/extensions/`) — jiti means no
build; `peerDependencies`: `@earendil-works/pi-coding-agent`, `typebox`, both `"*"`.

## 7. Milestones

### M0 — Ground truth on tgrep CLI (half day)
- [ ] `brew install tgrep` locally.
- [ ] Verify on a fixture repo: `serve` foreground vs daemon behavior; default index location
      (in-repo `.tgrep/`? → decide `--index-path` in user cache dir + `.gitignore` guidance);
      `status` output stability; `--json` line shape; `-C`, `-g`, `-F`, `-i`, `-m`, `--sort`
      parity with rg; exit codes; behavior when server already running (`serve` twice).
- **Acceptance**: written cheat-sheet of verified flags/formats; decisions recorded for
  `--index-path` and status parsing.

### M1 — Server manager + lifecycle (1 day)
- [ ] Package scaffold (`package.json` + manifest, tsconfig, entry).
- [ ] `config.ts`, `tgrep-client.ts`, `server-manager.ts`.
- [ ] `session_start` ensure-running + footer status; commands `/tgrep-status|reindex|stop`;
      `session_shutdown` per scope.
- **Acceptance**: fresh clone + `pi -e ./extensions` → server auto-starts, footer shows file
  count, second session reuses the server, `/tgrep-stop` kills it, `PI_TGREP_DISABLED=1` is a
  no-op.

### M2 — grep tool override (1 day)
- [ ] `grep-tool.ts` with schema parity, JSON parsing, truncation, abort, provenance details.
- [ ] rg fallback during index build; dormant registration when binary missing.
- **Acceptance**: headless `pi -p "use the grep tool to find X"` returns identical-shaped output
  to built-in (`details.engine === "tgrep"`); `limit`/`context`/`glob`/`ignoreCase`/`literal`
  behave the same; renderers unchanged.

### M3 — Bash interception (1 day)
- [ ] `bash-policy.ts`: detection, rg rewrite, grep flag translation, block-with-guidance,
      policy config.
- **Acceptance**: `pi -p "run rg -n foo src/ in bash"` executes `tgrep -n foo src/`;
  `pi -p "cat a && grep foo b"` gets blocked with redirect reason and the model recovers via the
  grep tool; `zgrep`/`git log --grep` untouched.

### M4 — Polish & distribution (half day)
- [ ] README (what/why, install, config table, architecture), error-message pass, edge cases
  (non-git dirs, session switching/forks, concurrent sessions).
- [ ] Local `pi install ./path` validation; npm publish prep (`pi-package` keyword).
- **Acceptance**: `pi install ./pi-tgrep` in a scratch project → all M1–M3 acceptance checks pass
  without `-e`.

## 8. Testing strategy

- **Headless E2E** (primary): `pi -p "<prompt>"` against the fixture repo with the extension
  loaded; assert on tool `details.engine`, rewritten bash commands (session log inspection), and
  `tgrep status` side effects.
- **Adversarial prompts**: "search for X using bash rg", "use grep tool", "cat f | grep x",
  "grep with context lines", "search only in *.ts".
- **Race test**: start session on unindexed repo, immediately search → must return rg-fallback
  complete results, then tgrep results once footer says complete.
- **Lifecycle test**: two concurrent sessions share one server; `/resume` + `/fork` keep exactly
  one server per repo.

## 9. Risks & open questions

| Risk | Mitigation |
|---|---|
| `tgrep status` text format changes | Parse defensively; primary source = `serve.json` + PID liveness |
| Flag gaps vs rg/grep (`-C`, `--include`) | M0 verification; unknown flags → block-with-guidance, never silent wrong results |
| Default index dir inside repo | `--index-path` into `~/.cache/tgrep/<repo-hash>` unless M0 shows a sane default |
| Empty-index window on first build | rg fallback until `Indexing: complete` |
| grep→tgrep translation breaks exotic commands | Quote-preserving re-emission keeps shell semantics; pipeline-aware policy translates scan segments and leaves stdin filters verbatim; anything untranslatable (BRE patterns, `ag/ack/pt`, unknown flags) blocks with guidance, never silently misruns |
| Server leaks across repos | Per-repo PID tracking; `/tgrep-stop`; `session` scope option |
| tgrep binary absent in CI/headless | Dormant mode; auto-install only ever behind explicit confirm |

## 10. Distribution

1. Local dev: `pi -e ./extensions`.
2. Git: `pi install git:github.com/danielmarbach/pi-tgrep`.
3. npm: publish with `pi-package` keyword → discoverable in the pi package gallery.
