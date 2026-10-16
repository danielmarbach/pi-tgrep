import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyBashPolicy } from "../src/bash-policy.ts";
import { isGitIgnored } from "../src/git-ignore.ts";

const execFileP = promisify(execFile);

// Differential test: run each battery command as written (real grep/rg, no extension) and as
// rewritten by applyBashPolicy (real tgrep on a real index), then compare sorted stdout and exit code.

delete process.env.PI_TGREP_INDEX_PATH;

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/repo");

/** Files added on top of test/fixtures/repo; one line per case the battery needs to tell apart. */
const EXTRA_FILES = {
  "src/Sample.cs": [
    "public class Foo : IBehavior<Foo>",
    "var buf = stream.GetBuffer();",
    "var xGetBuffer = 1;",
    "foo",
    "bar",
    "foobar",
    "foo|bar",
    "fooxbar",
    "foo.bar",
    "a+b",
    "aab",
    "aaab",
    "ab",
    "a?b",
    "f(x)",
    "f(x",
    "x{2}",
    "xx",
    "{1}",
    "*star",
    "a*b",
    "a^b",
    "a$b",
    "^caret",
    "caret",
    "end$",
    "end",
    "(foo)",
    "a.b",
    "a\\.b",
    "costs $5",
    "word",
    "sword",
    "words",
    "a word here",
    "[bracket]",
    "back\\slash",
    "abcabc",
    "Foo2",
    "FOO",
    "",
  ].join("\n"),
  "src/nested/deep.ts": "export const needle = 1;\nexport const NEEDLE = 2;\n",
  "docs/notes.txt": "plain notes\nneedle in notes\n",
  "App.sln": 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "App.csproj", "{GUID}"\nEndProject\n',
  "build.log": "needle in an ignored log\n",
  "secrets/key.txt": "needle in an ignored dir\n",
};

/**
 * Battery entries are `{ cmd }` plus at most one expectation:
 * - nothing: the policy must rewrite the command and the output must match the original.
 * - `verbatim: true`: the policy must leave the command alone (no translation exists).
 * - `known: reason`: a documented difference; the test fails once the outputs agree, so delete the entry then.
 */
const BATTERY = [
  { cmd: "rg -n needle src" },
  { cmd: "rg -l needle ." },
  { cmd: "rg -c needle src" },
  { cmd: "rg -i NEEDLE docs" },
  { cmd: "rg -w word src" },
  { cmd: "rg -x word src" },
  { cmd: "rg -v needle docs" },
  { cmd: "rg -o 'need\\w+' src" },
  { cmd: "rg -F 'a.b' src" },
  { cmd: "rg -F 'foo.bar' src" },
  { cmd: "rg -e foo -e needle src" },
  { cmd: "rg -g '*.ts' needle ." },
  { cmd: "rg -g '!*.ts' needle ." },
  { cmd: "rg -A1 needle docs" },
  { cmd: "rg -B1 -n needle docs" },
  { cmd: "rg -C1 needle docs" },
  { cmd: "rg -m1 needle src" },
  { cmd: "rg --files-without-match needle src" },
  { cmd: "rg -n 'foo|bar' src" },
  { cmd: "rg -n '^\\s*public\\s+class' src" },
  { cmd: "rg -n 'a+b' src" },
  { cmd: "rg -n 'zzzznomatch' src" },
  { cmd: "rg needle src/nested/deep.ts" },
  { cmd: "rg -n needle build.log" },

  { cmd: "grep -rn needle src" },
  { cmd: "grep -rn needle src docs" },
  { cmd: "grep -rl needle src docs" },
  { cmd: "grep -rn --include=*.ts needle src docs" },
  { cmd: "grep -rni NEEDLE docs" },
  { cmd: "grep -rnw word src" },
  { cmd: "grep -rnx word src" },
  { cmd: "grep -rnv needle docs" },
  { cmd: "grep -rno 'need[a-z]*' src" },
  { cmd: "grep -rnF 'foo.bar' src" },
  { cmd: "grep -rnE 'foo|bar' src" },
  { cmd: "grep -rnE 'a+b' src" },
  { cmd: "grep -rnE 'f\\(x\\)' src" },
  { cmd: "grep -rn -e foo -e needle src" },
  { cmd: "grep -rn --include='*.ts' needle ." },
  { cmd: "grep -rn --include=*.cs foo src" },
  { cmd: "grep -rn --exclude='*.ts' needle src docs" },
  { cmd: "grep -rn --exclude-dir=nested needle src" },
  { cmd: "grep -rn -A1 needle docs" },
  { cmd: "grep -rn -B1 needle docs" },
  { cmd: "grep -rn -C1 needle docs" },
  { cmd: "grep -rn -m1 needle src" },
  { cmd: "grep -n needle src/app.ts" },
  { cmd: "grep -c needle src/app.ts" },
  { cmd: "grep -n needle src/app.ts src/util.ts" },
  { cmd: "grep -n needle src/*.ts" },
  { cmd: "grep -rn zzzznomatch src" },
  { cmd: "grep -rh needle src" },
  { cmd: "grep -rq needle src" },
  { cmd: "grep -rq zzzznomatch src" },
  { cmd: "fgrep -rn 'foo.bar' src" },
  { cmd: "egrep -rn 'foo|bar' src" },
  { cmd: "grep -rnE 'a|b' src | wc -l" },

  { cmd: "grep -rn needle src/app.ts" },
  { cmd: "grep -rc needle src/app.ts" },
  { cmd: "grep -rn needle build.log" },
  { cmd: "grep -rn needle .", known: "grep does not read .gitignore; tgrep skips ignored files (by design)" },
  { cmd: "grep -rc needle src", known: "grep -c lists files with a zero count; tgrep omits them" },
  { cmd: "rg -n needle secrets" },
  { cmd: "grep -rn needle secrets" },
];

/** BRE patterns that must convert to tgrep's ERE without changing what grep matches, grouped by rule. */
const BRE_CONVERTIBLE = [
  // \| \( \) \{ \} \+ \? become |, (, ), {, }, +, ?
  "foo\\|bar",
  "foo\\|^bar",
  "foo\\|bar\\|word",
  "\\(foo\\)\\|\\(bar\\)",
  "^\\(foo\\|bar\\)$",
  "fo\\{2\\}",
  "a\\{2,\\}b",
  "a\\{1,2\\}b",
  "a\\+b",
  "ab\\?",
  "a\\?b",
  "\\(ab\\)\\+",
  "\\(abc\\)\\{2\\}",
  "a\\(b\\|c\\)*",
  // \< and \> become \b
  "\\<word",
  "word\\>",
  "\\<word\\>",
  "\\<sw",
  "s\\+\\>",
  "\\<f\\+",
  "\\<foo\\>\\|\\<bar\\>",
  // unescaped ( ) { } + ? | are literal in BRE
  "f(x)",
  "f(x",
  "x{2}",
  "{1}",
  "}",
  "a+b",
  "a?b",
  "foo|bar",
  "(foo)",
  "foo\\|a|b",
  "Project(",
  "stream.GetBuffer()",
  "IBehavior<Foo>",
  // * is literal at the start of a pattern, group or alternative
  "*star",
  "^*star",
  "\\(*star\\)",
  "foo\\|*star",
  "a*b",
  "ab*",
  // ^ and $ are anchors only at the edges
  "a^b",
  "a$b",
  "costs $5",
  "^caret",
  "end$",
  "^foo$",
  "\\(^foo\\)",
  "\\(foo$\\)",
  // escapes and brackets pass through
  "a\\.b",
  "\\[bracket\\]",
  "back\\\\slash",
  "\\^caret",
  "a\\$b",
  "[a-z]\\+x",
  "[]x]",
  "[^]x]b",
  "[[:alpha:]]\\+",
  "[(]x",
  "[+?|]",
  "\\w\\+\\s",
  "\\bfoo\\b",
];

const BRE_UNCONVERTIBLE = [
  "\\(a\\)\\1",
  "\\(.\\)\\1",
  "a\\{,2\\}",
  "\\{1\\}",
  "\\+a",
  "a*\\+",
  "\\<\\(foo\\)",
  "\\<f*",
  "foo$\\|^bar",
  "foo\\|",
  "\\|foo",
  "\\(\\)",
  "foo\\>*",
  "a\\(b",
  "a\\)b",
  "[\\w.]",
  "[a&&b]",
  "\\d",
  "\\t",
];

BATTERY.push(
  { cmd: "grep -rn 'foo\\|bar' src --include='*.ts'" },
  { cmd: "grep -n 'Project(' App.sln" },
  { cmd: "grep -rn '\\.GetBuffer()' src" },
  { cmd: "grep -rni 'FOO\\|bar' src --include='*.cs'" },
  { cmd: "grep -rnw 'foo\\|word' src --include='*.cs'" },
  { cmd: "grep -rnx 'foo\\|word' src --include='*.cs'" },
  { cmd: "grep -rno 'fo\\+' src --include='*.cs'" },
  { cmd: "grep -rc 'foo\\|bar' src --include='*.cs'" },
  { cmd: "grep -rl 'foo\\|needle' src docs" },
  { cmd: "grep -rnv 'foo\\|bar' docs" },
  { cmd: "grep -rn -e 'foo\\|word' -e 'a+b' src --include='*.cs'" },
  { cmd: "grep -rn --regexp='foo\\|word' src --include='*.cs'" },
  { cmd: "grep -rnG 'foo\\|word' src --include='*.cs'" },
  { cmd: 'grep -rn "foo\\|word" src --include="*.cs"' },
  { cmd: "grep -rnE 'foo\\|bar' src --include='*.cs'" },
  { cmd: "grep -rnF 'foo\\|bar' src --include='*.cs'" },
  { cmd: "grep -rn 'foo\\|bar' src --include='*.cs' | wc -l" },
);
for (const pattern of BRE_CONVERTIBLE) BATTERY.push({ cmd: `grep -rn '${pattern}' src --include='*.cs'` });
for (const pattern of BRE_UNCONVERTIBLE) BATTERY.push({ cmd: `grep -rn '${pattern}' src --include='*.cs'`, verbatim: true });

function which(bin) {
  const found = spawnSync("which", [bin], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}

function missingTools() {
  return ["tgrep", "rg", "grep", "git"].filter((bin) => which(bin) === null);
}

function runShell(command, cwd) {
  const r = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", timeout: 30_000 });
  const lines = (r.stdout ?? "").split("\n").filter((line) => line !== "");
  // Output order is not part of the contract: tgrep and grep -r walk directories differently.
  return { lines: lines.sort(), code: r.status };
}

async function createFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-diff-"));
  await cp(FIXTURE, dir, { recursive: true });
  for (const [file, content] of Object.entries(EXTRA_FILES)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  await execFileP("git", ["init", "-q"], { cwd: dir });
  await execFileP("tgrep", ["index", "--force", "."], { cwd: dir });
  return dir;
}

function describeDiff(original, translated) {
  const missing = original.lines.filter((line) => !translated.lines.includes(line));
  const extra = translated.lines.filter((line) => !original.lines.includes(line));
  return [
    `exit ${original.code} -> ${translated.code}`,
    `lines ${original.lines.length} -> ${translated.lines.length}`,
    `missing from tgrep: ${JSON.stringify(missing.slice(0, 3))}`,
    `extra in tgrep: ${JSON.stringify(extra.slice(0, 3))}`,
  ].join("; ");
}

async function runBattery(dir) {
  const context = {
    indexPath: path.join(dir, ".tgrep"),
    cwd: dir,
    isIgnored: (cwd, operand) => isGitIgnored(dir, path.resolve(cwd, operand)),
  };
  const failures = [];
  let compared = 0;
  for (const entry of BATTERY) {
    const policy = await applyBashPolicy(entry.cmd, "translate", context);
    if (entry.verbatim) {
      if (policy.action !== "allow") failures.push(`${entry.cmd}: expected verbatim, got ${policy.action}: ${policy.command ?? policy.reason}`);
      continue;
    }
    if (policy.action !== "rewrite") {
      failures.push(`${entry.cmd}: expected a rewrite, got ${policy.action}: ${policy.reason ?? ""}`);
      continue;
    }
    const original = runShell(entry.cmd, dir);
    const translated = runShell(policy.command, dir);
    const same = original.code === translated.code && JSON.stringify(original.lines) === JSON.stringify(translated.lines);
    compared++;
    if (entry.known) {
      if (same) failures.push(`${entry.cmd}: listed as a known difference (${entry.known}) but the outputs now agree; remove the entry`);
    } else if (!same) {
      failures.push(`${entry.cmd}\n    rewritten: ${policy.command.replace(context.indexPath, "<index>")}\n    ${describeDiff(original, translated)}`);
    }
  }
  assert.deepEqual(failures, [], `differential mismatches:\n${failures.join("\n")}`);
  return compared;
}

const missing = missingTools();
if (missing.length) {
  console.log(`differential tests skipped (not installed: ${missing.join(", ")})`);
} else {
  const dir = await createFixture();
  try {
    const compared = await runBattery(dir);
    console.log(`differential tests ok (${compared} commands compared)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
