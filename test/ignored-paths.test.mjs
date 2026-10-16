import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyBashPolicy } from "../src/bash-policy.ts";
import { buildTgrepArgs, createGrepToolOverride } from "../src/grep-tool.ts";
import { isGitIgnored } from "../src/git-ignore.ts";
import { repoRoot } from "../src/server-manager.ts";

const execFileP = promisify(execFile);
delete process.env.PI_TGREP_INDEX_PATH;

const pi = {
  async exec(command, args, options = {}) {
    try {
      const { stdout, stderr } = await execFileP(command, args, { cwd: options.cwd, timeout: options.timeout });
      return { stdout, stderr, code: 0, killed: false };
    } catch (err) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(err.message),
        code: typeof err.code === "number" ? err.code : 1,
        killed: Boolean(err.killed),
      };
    }
  },
};

const repoDir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-ignored-"));
const write = async (rel, text) => {
  await mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
  await writeFile(path.join(repoDir, rel), text);
};

async function lines(command, args) {
  try {
    const { stdout } = await execFileP(command, args, { cwd: repoDir, encoding: "utf8" });
    return stdout.split("\n").filter(Boolean);
  } catch (err) {
    if (err.code === 1) return [];
    throw err;
  }
}

try {
  await execFileP("git", ["init"], { cwd: repoDir });
  await write(".gitignore", "bin/\nobj/\n");
  await write("src/app.txt", "ERROR in app\n");
  await write("tests/T/unit.txt", "ERROR in unit\n");
  await write("tests/T/bin/Debug/log.txt", "ERROR in build log\n");
  await write("obj/gen/out.txt", "ERROR in generated\n");
  await execFileP("git", ["add", "-A"], { cwd: repoDir });
  await execFileP("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repoDir });
  await execFileP("tgrep", ["index", repoDir]);

  const root = await repoRoot(repoDir);
  const isIgnored = async (cwd, operand) => isGitIgnored(root, path.resolve(cwd, operand));
  const ctx = { cwd: repoDir, ui: {} };
  const tool = createGrepToolOverride(pi);

  // `.git/HEAD` is never reported ignored by git and must stay searchable with --hidden
  const SEARCHES = [
    { label: "ignored dir", target: "tests/T/bin/Debug", pattern: "ERROR", expected: 1 },
    { label: "ignored single file", target: "tests/T/bin/Debug/log.txt", pattern: "ERROR", expected: 1 },
    { label: "ignored top-level dir", target: "obj", pattern: "ERROR", expected: 1 },
    { label: "normal subtree", target: "tests/T", pattern: "ERROR", expected: 1 },
    { label: "repo-wide", target: ".", pattern: "ERROR", expected: 2 },
    { label: ".git file", target: ".git/HEAD", pattern: "ref:", expected: 1 },
  ];

  for (const { label, target, pattern, expected } of SEARCHES) {
    const rg = await lines("rg", ["--hidden", "-n", pattern, target]);
    assert.equal(rg.length, expected, `${label}: rg baseline`);

    const toolResult = await tool.execute("t", { pattern, path: target }, undefined, undefined, ctx);
    const toolHits = toolResult.content[0].text === "No matches found" ? [] : toolResult.content[0].text.split("\n").filter(Boolean);
    assert.equal(toolHits.length, rg.length, `${label}: grep tool hits (${JSON.stringify(toolHits)})`);

    const policy = await applyBashPolicy(`rg --hidden -n ${pattern} ${target}`, "translate", {
      cwd: repoDir,
      indexPath: path.join(repoDir, ".tgrep"),
      isIgnored,
    });
    assert.equal(policy.action, "rewrite", `${label}: shell command is translated`);
    const shell = await lines("bash", ["-c", policy.command]);
    assert.equal(shell.length, rg.length, `${label}: shell translation hits (${policy.command} -> ${JSON.stringify(shell)})`);
  }

  const withIgnored = buildTgrepArgs({ pattern: "x" }, repoDir, { root: repoDir, indexDirExists: true, searchPathIgnored: true });
  assert.ok(withIgnored.includes("--no-ignore-parent"));
  const withoutIgnored = buildTgrepArgs({ pattern: "x" }, repoDir, { root: repoDir, indexDirExists: true });
  assert.ok(!withoutIgnored.includes("--no-ignore-parent"));

  assert.equal(await isGitIgnored(root, path.join(repoDir, "tests/T/bin/Debug")), true);
  assert.equal(await isGitIgnored(root, path.join(repoDir, "tests/T")), false);
  assert.equal(await isGitIgnored(root, path.join(repoDir, "missing/bin")), false);
  assert.equal(await isGitIgnored(root, path.join(repoDir, "..")), false);
  assert.equal(await isGitIgnored(root, path.join(repoDir, ".git/HEAD")), false);

  console.log("ignored path tests ok");
} finally {
  await rm(repoDir, { recursive: true, force: true });
}
