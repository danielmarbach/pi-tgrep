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
  await policyCase('grep -c "" f', "translate", { action: "rewrite", command: "tgrep search -c '' f" });
  await policyCase("grep -c '' f", "translate", { action: "rewrite", command: "tgrep search -c '' f" });
  console.log("empty pattern emission tests ok");
}

async function runUnquotedGlobTests() {
  // Unquoted globs/tildes/braces must stay unquoted so the shell expands them, not tgrep.
  await policyCase("grep -n X src/*.ts", "translate", {
    action: "rewrite",
    command: "tgrep search -n X src/*.ts",
  });
  await policyCase("rg -n X src/*.ts", "translate", {
    action: "rewrite",
    command: "tgrep search -n X src/*.ts",
  });
  await policyCase("grep -n X src/{a,b}.ts", "translate", {
    action: "rewrite",
    command: "tgrep search -n X src/{a,b}.ts",
  });
  // ~/proj is unquoted (tilde expansion) and absolute once expanded, so no --index-path injection.
  const home = await policyCase("grep -rn X ~/proj", "translate", {
    action: "rewrite",
    command: "tgrep search -n X ~/proj",
  }, IDX);
  assert.ok(!home.command.includes("--index-path"), "unquoted ~ path must skip index-path injection");
  console.log("unquoted glob/tilde/brace emission tests ok");
}

async function runQuotedTokensStayQuotedTests() {
  await policyCase("grep -n X 'src/*.ts'", "translate", {
    action: "rewrite",
    command: "tgrep search -n X 'src/*.ts'",
  });
  await policyCase("grep -n 'foo bar' f", "translate", {
    action: "rewrite",
    command: "tgrep search -n 'foo bar' f",
  });
  // Literal '|' is text in BRE but alternation in tgrep's engine, so this must run unchanged.
  await policyCase("grep -n 'foo|bar' f", "translate", { action: "allow" });
  // Synthesized -g globs from --include/--exclude must always stay quoted, regardless of source quoting.
  await policyCase("grep -rn --include='*.cs' needle .", "translate", {
    action: "rewrite",
    command: "tgrep search -n -g '*.cs' needle .",
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
    assert.equal(result.command, "tgrep search -n needle src/*.ts");
    const { stdout } = await execFileP("/bin/sh", ["-c", result.command], { cwd: dir, encoding: "utf8" });
    assert.match(stdout, /src\/a\.ts:1:/, `expected a.ts match, got: ${stdout}`);
    assert.match(stdout, /src\/b\.ts:1:/, `expected b.ts match, got: ${stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("shell glob expansion exec test ok");
}

await runEmptyPatternTests();
await runUnquotedGlobTests();
await runQuotedTokensStayQuotedTests();
await runShellGlobExpansionExecTest();
console.log("ALL EMISSION TESTS PASSED");
