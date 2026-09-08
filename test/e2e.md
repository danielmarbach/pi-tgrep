# E2E validation scripts

Run from `test/fixtures/repo` unless noted. `EXT` = absolute path to this repo's `extensions/`.

## Automated harness (no provider needed)

```bash
node test/harness.mjs
```

Covers: bash-policy translate/block/warn/off matrix, grep-tool execute (engine provenance,
gitignore respect, limit notice, context lines, glob, literal, ignoreCase), server-manager
lifecycle (detached serve, git exclude, indexed search, monitor, stop).

## Headless pi runs (need model credentials)

1. grep override routes through tgrep:

   ```bash
   pi -e $EXT -t grep -xt mcp -p "Search for needle."
   ```

   Expected: result text uses `path:line: text` shape, no `notes.log`/`secrets/` entries;
   newest session log shows a `grep` toolResult with `details: {"engine": "tgrep"}`.

2. bash interception (block path):

   ```bash
   pi -e $EXT -p "Run this exact bash command: grep -rn needle ."
   ```

   Expected: the bash tool call is blocked with the reason "Command uses grep/rg in the
   shell, which bypasses the tgrep index…", and the model recovers via the grep tool.

3. bash interception (translate path):

   ```bash
   pi -e $EXT -p "Run this exact bash command: rg -n needle src/"
   ```

   Expected: executed command becomes `tgrep -n needle src/` (check session log
   toolCall arguments for `bash`).

4. auto-index lifecycle:

   ```bash
   pi -e $EXT -p "say hi"
   ```

   Expected: `.tgrep/serve.json` appears in the fixture repo, `.tgrep/` is appended to
   `.git/info/exclude`, `tgrep status .` reports a live server; a second run reuses it.

5. kill switch:

   ```bash
   PI_TGREP_DISABLED=1 pi -e $EXT -p "say hi"
   ```

   Expected: no `.tgrep/` created, no status line, built-in grep untouched.

## Manual interactive checks

- `/tgrep-status`, `/tgrep-reindex`, `/tgrep-stop` notify repo status.
- Footer shows `tgrep: N files` while a server is up; `tgrep: indexing…` during first build.
- `PI_TGREP_SCOPE=session pi …` stops the server it started on quit.
