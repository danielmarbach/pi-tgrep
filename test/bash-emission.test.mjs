import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyBashPolicy } from "../src/bash-policy.ts";

const execFileP = promisify(execFile);
const IDX = { indexPath: "/repo/.tgrep" };

async function policyCase(command, mode, expect, context) {
  const result = await applyBashPolicy(command, mode, context);
  assert.deepEqual(
    { action: result.action, command: result.command },
    { action: expect.action, command: expect.command },
    `policy(${mode}): ${command}`,
  );
  return result;
}

async function runEmptyPatternTests() {
  // An empty positional must survive as its own token, not vanish into a double space.
  await policyCase('grep -c "" f', "translate", { action: "rewrite", command: "tgrep search --hidden -c --include-zero '' f" });
  await policyCase("grep -c '' f", "translate", { action: "rewrite", command: "tgrep search --hidden -c --include-zero '' f" });
  console.log("empty pattern emission tests ok");
}

async function runCountEmissionTests() {
  // grep -c prints 0 for files without a match; tgrep only does with --include-zero. rg -c omits them too.
  const rewrite = (command) => ({ action: "rewrite", command });
  await policyCase("grep -c needle f", "translate", rewrite("tgrep search --hidden -c --include-zero needle f"));
  await policyCase("grep --count needle f", "translate", rewrite("tgrep search --hidden -c --include-zero needle f"));
  await policyCase("egrep -c 'a|b' f g", "translate", rewrite("tgrep search --hidden -c --include-zero 'a|b' f g"));
  await policyCase("fgrep -c a.b f", "translate", rewrite("tgrep search --hidden -F -c --include-zero a.b f"));
  await policyCase("grep -rnc needle src", "translate", rewrite("tgrep search --hidden -n -c --include-zero needle src"));
  await policyCase("grep -n needle f", "translate", rewrite("tgrep search --hidden -n needle f"));
  await policyCase("rg -c needle f", "translate", rewrite("tgrep search -c needle f"));
  console.log("count emission tests ok");
}

async function runHiddenEmissionTests() {
  // grep searches dotfiles and dot directories; tgrep skips them unless --hidden. rg skips them too.
  const rewrite = (command) => ({ action: "rewrite", command });
  await policyCase("grep -rn needle .github", "translate", rewrite("tgrep search --hidden -n needle .github"));
  await policyCase("egrep -rn 'a|b' .", "translate", rewrite("tgrep search --hidden -n 'a|b' ."));
  await policyCase("fgrep -rn a.b .", "translate", rewrite("tgrep search --hidden -F -n a.b ."));
  await policyCase("rg -n needle .", "translate", rewrite("tgrep search -n needle ."));
  await policyCase("rg --hidden -n needle .", "translate", rewrite("tgrep search --hidden -n needle ."));
  console.log("hidden emission tests ok");
}

async function runRepeatedFlagTests() {
  // tgrep (clap) rejects a repeated flag that grep and rg accept; repeats collapse before emission.
  const rewrite = (command) => ({ action: "rewrite", command });
  await policyCase("grep -n 'export MODEL=' -n SKILL.md", "translate", rewrite("tgrep search --hidden -n 'export MODEL=' SKILL.md"));
  await policyCase("grep -n --line-number foo f", "translate", rewrite("tgrep search --hidden -n foo f"));
  await policyCase("grep -rli 'a\\|b' --include='*' -l .", "translate", rewrite("tgrep search --hidden -l -i -g '*' 'a|b' ."));
  await policyCase("grep -i foo -i f", "translate", rewrite("tgrep search --hidden -i foo f"));
  await policyCase("grep -c -c foo f", "translate", rewrite("tgrep search --hidden -c --include-zero foo f"));
  await policyCase("fgrep -F a.b f", "translate", rewrite("tgrep search --hidden -F a.b f"));
  await policyCase("rg -n --line-number foo .", "translate", rewrite("tgrep search -n foo ."));
  await policyCase("rg --hidden --hidden foo .", "translate", rewrite("tgrep search --hidden foo ."));
  await policyCase("rg foo . -i -n --ignore-case", "translate", rewrite("tgrep search foo . -i -n"));
  // A repeated flag that takes a value keeps the last one, in the position of the last one.
  await policyCase("grep -A 1 -A 2 foo f", "translate", rewrite("tgrep search --hidden -A 2 foo f"));
  await policyCase("grep -A1 -n -A2 foo f", "translate", rewrite("tgrep search --hidden -n -A 2 foo f"));
  await policyCase("grep -m 1 --max-count=3 foo f", "translate", rewrite("tgrep search --hidden -m 3 foo f"));
  await policyCase("grep --color=never --color=always foo f", "translate", rewrite("tgrep search --hidden --color always foo f"));
  await policyCase("rg -C 1 -C 2 foo .", "translate", rewrite("tgrep search -C 2 foo ."));
  await policyCase("rg --max-count=1 -m 2 foo .", "translate", rewrite("tgrep search -m 2 foo ."));
  await policyCase("rg --sort path --sort none foo .", "translate", rewrite("tgrep search --sort none foo ."));
  // Flags tgrep lets repeat are all kept.
  await policyCase("grep -e a -e b f", "translate", rewrite("tgrep search --hidden -e a -e b f"));
  await policyCase("rg -g '*.ts' -g '*.md' foo .", "translate", rewrite("tgrep search -g '*.ts' -g '*.md' foo ."));
  await policyCase("rg -t cs -t py foo .", "translate", rewrite("tgrep search -t cs -t py foo ."));
  // A search path that is git-ignored must not duplicate a --no-ignore-parent the user already passed.
  await policyCase("rg --no-ignore-parent -l ERROR bin/Debug", "translate", rewrite("tgrep search --no-ignore-parent -l ERROR bin/Debug"), {
    isIgnored: () => Promise.resolve(true),
  });
  console.log("repeated flag emission tests ok");
}

async function runUnquotedGlobTests() {
  // Unquoted globs/tildes/braces must stay unquoted so the shell expands them, not tgrep.
  await policyCase("grep -n X src/*.ts", "translate", {
    action: "rewrite",
    command: "tgrep search --hidden -n X src/*.ts",
  });
  await policyCase("rg -n X src/*.ts", "translate", {
    action: "rewrite",
    command: "tgrep search -n X src/*.ts",
  });
  await policyCase("grep -n X src/{a,b}.ts", "translate", {
    action: "rewrite",
    command: "tgrep search --hidden -n X src/{a,b}.ts",
  });
  // ~/proj is unquoted (tilde expansion) and absolute once expanded, so no --index-path injection.
  const home = await policyCase("grep -rn X ~/proj", "translate", {
    action: "rewrite",
    command: "tgrep search --hidden -n X ~/proj",
  }, IDX);
  assert.ok(!home.command.includes("--index-path"), "unquoted ~ path must skip index-path injection");
  console.log("unquoted glob/tilde/brace emission tests ok");
}

async function runQuotedTokensStayQuotedTests() {
  await policyCase("grep -n X 'src/*.ts'", "translate", {
    action: "rewrite",
    command: "tgrep search --hidden -n X 'src/*.ts'",
  });
  await policyCase("grep -n 'foo bar' f", "translate", {
    action: "rewrite",
    command: "tgrep search --hidden -n 'foo bar' f",
  });
  // Literal '|' is text in BRE but alternation in tgrep's engine, so it is escaped.
  await policyCase("grep -n 'foo|bar' f", "translate", { action: "rewrite", command: "tgrep search --hidden -n 'foo\\|bar' f" });
  // A converted pattern that was unquoted in the source must come out quoted.
  await policyCase("grep a+ f", "translate", { action: "rewrite", command: "tgrep search --hidden 'a\\+' f" });
  await policyCase("grep -rn 'it'\\''s\\|x' src", "translate", { action: "rewrite", command: "tgrep search --hidden -n 'it'\\''s|x' src" });
  // Synthesized -g globs from --include/--exclude must always stay quoted, regardless of source quoting.
  await policyCase("grep -rn --include='*.cs' needle .", "translate", {
    action: "rewrite",
    command: "tgrep search --hidden -n -g '*.cs' needle .",
  });
  console.log("quoted token / synthesized glob emission tests ok");
}

async function runShellGlobExpansionExecTest() {
  let hasTgrep = true;
  try {
    await execFileP("which", ["tgrep"]);
  } catch {
    hasTgrep = false;
  }
  if (!hasTgrep) {
    console.log("shell glob expansion exec test skipped (tgrep not installed)");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-emission-"));
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src/a.ts"), "const needle = 1;\n");
    await writeFile(path.join(dir, "src/b.ts"), "const needle = 2;\n");
    const result = await applyBashPolicy("grep -n needle src/*.ts", "translate");
    assert.equal(result.action, "rewrite");
    assert.equal(result.command, "tgrep search --hidden -n needle src/*.ts");
    const { stdout } = await execFileP("/bin/sh", ["-c", result.command], { cwd: dir, encoding: "utf8" });
    assert.match(stdout, /src\/a\.ts:1:/, `expected a.ts match, got: ${stdout}`);
    assert.match(stdout, /src\/b\.ts:1:/, `expected b.ts match, got: ${stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("shell glob expansion exec test ok");
}

await runEmptyPatternTests();
await runCountEmissionTests();
await runHiddenEmissionTests();
await runRepeatedFlagTests();
await runUnquotedGlobTests();
await runQuotedTokensStayQuotedTests();
await runShellGlobExpansionExecTest();
console.log("ALL EMISSION TESTS PASSED");
