import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyBashPolicy } from "../src/bash-policy.ts";
import { createGrepToolOverride } from "../src/grep-tool.ts";
import { repoRoot, ServerManager } from "../src/server-manager.ts";
import { status, stopServer } from "../src/tgrep-client.ts";

const execFileP = promisify(execFile);

const pi = {
  async exec(command, args, options = {}) {
    try {
      const { stdout, stderr } = await execFileP(command, args, {
        cwd: options.cwd,
        timeout: options.timeout,
      });
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

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/repo");

function policyCase(command, mode, expect) {
  const result = applyBashPolicy(command, mode);
  assert.deepEqual(
    { action: result.action, command: result.command },
    { action: expect.action, command: expect.command },
    `policy(${mode}): ${command}`,
  );
}

function runPolicyTests() {
  policyCase("rg -n needle src/", "translate", { action: "rewrite", command: "tgrep -n needle src/" });
  policyCase("rg -n 'foo|bar' .", "translate", { action: "block" });
  policyCase("rg -g '*.ts' needle src/", "translate", { action: "block" });
  policyCase('rg -n "two words" .', "translate", { action: "block" });
  policyCase("grep -rn --include=*.ts needle .", "translate", {
    action: "rewrite",
    command: "tgrep -n -g *.ts needle .",
  });
  policyCase("cat f | grep needle", "translate", { action: "block" });
  policyCase("zgrep needle x.log", "translate", { action: "allow" });
  policyCase("git log --grep needle", "translate", { action: "allow" });
  policyCase("grep 'a\\(b\\)' f", "translate", { action: "block" });
  policyCase("rg --files", "translate", { action: "rewrite", command: "tgrep --files" });
  policyCase("sudo grep -i needle /etc/hosts", "translate", {
    action: "rewrite",
    command: "sudo tgrep -i needle /etc/hosts",
  });
  policyCase("grep -rn needle .", "block", { action: "block" });
  policyCase("rg -n needle .", "off", { action: "allow" });
  policyCase("grep -rn needle .", "warn", { action: "warn", command: "grep -rn needle ." });
  policyCase("ls src/", "translate", { action: "allow" });
  policyCase("ag -l needle", "translate", { action: "block" });
  policyCase("grep --exclude-dir=node_modules -r needle .", "translate", {
    action: "rewrite",
    command: "tgrep -g !node_modules/** needle .",
  });
  policyCase("fgrep -n 'a.b' .", "translate", { action: "block" });
  policyCase("egrep 'ab+c' .", "translate", { action: "block" });
  console.log("policy tests ok");
}

async function runGrepToolTests(repoDir) {
  const tool = createGrepToolOverride(pi);
  const ctx = { cwd: repoDir, ui: {} };
  const signal = undefined;

  const plain = await tool.execute("t1", { pattern: "needle" }, signal, undefined, ctx);
  assert.equal(plain.details.engine, "tgrep");
  assert.match(plain.content[0].text, /src\/app\.ts:\d+: /);
  assert.ok(!plain.content[0].text.includes("notes.log"), "gitignored file must be excluded");
  assert.ok(!plain.content[0].text.includes("secrets/"), "gitignored dir must be excluded");

  const limited = await tool.execute("t2", { pattern: "needle", limit: 1 }, signal, undefined, ctx);
  assert.equal(limited.details.matchLimitReached, 1);
  assert.match(limited.content[0].text, /1 matches limit reached/);

  const withCtx = await tool.execute("t3", { pattern: "haystack", context: 1, path: "docs" }, signal, undefined, ctx);
  assert.match(withCtx.content[0].text, /guide\.md-\d+- /);
  assert.match(withCtx.content[0].text, /guide\.md:\d+: The needle is in the haystack\./);

  const globbed = await tool.execute("t4", { pattern: "needle", glob: "*.md" }, signal, undefined, ctx);
  assert.ok(globbed.content[0].text.includes("guide.md"));
  assert.ok(!globbed.content[0].text.includes("app.ts"));

  const literal = await tool.execute("t5", { pattern: "a.b", literal: true, path: "src" }, signal, undefined, ctx);
  assert.equal(literal.content[0].text, "No matches found");

  const noMatch = await tool.execute("t6", { pattern: "zzznotfound" }, signal, undefined, ctx);
  assert.equal(noMatch.content[0].text, "No matches found");
  assert.equal(noMatch.details.engine, "tgrep");

  const ignoreCase = await tool.execute("t7", { pattern: "NEEDLE", ignoreCase: true, path: "docs" }, signal, undefined, ctx);
  assert.ok(ignoreCase.content[0].text.includes("guide.md"));

  console.log("grep tool tests ok");
}

async function runServerManagerTests(workDir) {
  const manager = new ServerManager(pi, {
    disabled: false,
    autoInstall: "never",
    bashPolicy: "translate",
    serveArgs: [],
    scope: "repo",
  });

  const root = await repoRoot(workDir);
  assert.equal(root, path.resolve(workDir));
  assert.equal(await repoRoot("/private/tmp"), null, "non-git directory must yield null repoRoot");

  const st = await manager.ensureRunning(root);
  assert.equal(st.kind, "server", `expected server, got ${JSON.stringify(st)}`);
  assert.equal(st.indexingComplete, true);

  const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf-8");
  assert.match(exclude, /^\.tgrep\/$/m);

  const search = await pi.exec("tgrep", ["-n", "needle", "."], { cwd: workDir });
  assert.equal(search.code, 0);
  assert.match(search.stdout, /app\.ts/);

  const monitorDone = new Promise((resolve) => {
    void manager.monitor(root, () => {}, 5_000).then(resolve);
  });
  await monitorDone;

  assert.equal(await manager.stop(root), true);
  const after = await status(pi, root);
  assert.equal(after.kind, "index", `expected index-only after stop, got ${JSON.stringify(after)}`);

  console.log("server manager tests ok");
}

const repoDir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-fixture-"));
await cp(FIXTURE, repoDir, { recursive: true });
await execFileP("git", ["init"], { cwd: repoDir });
try {
  runPolicyTests();
  await runGrepToolTests(repoDir);
  await runServerManagerTests(repoDir);
} finally {
  await rm(repoDir, { recursive: true, force: true });
}
console.log("ALL HARNESS TESTS PASSED");
