import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyBashPolicy } from "../src/bash-policy.ts";
import { applyToolCallPolicy } from "../src/watched-tools.ts";
import { loadConfig } from "../src/config.ts";
import { buildTgrepArgs, createGrepToolOverride } from "../src/grep-tool.ts";
import { repoRoot, ServerManager } from "../src/server-manager.ts";
import { status, stopServer } from "../src/tgrep-client.ts";

const execFileP = promisify(execFile);

// An exported PI_TGREP_INDEX_PATH would redirect the fixture server and the --index-path assertions.
delete process.env.PI_TGREP_INDEX_PATH;

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
  policyCase("rg -n 'foo|bar' .", "translate", { action: "rewrite", command: "tgrep -n 'foo|bar' ." });
  policyCase("rg -g '*.ts' needle src/", "translate", { action: "rewrite", command: "tgrep -g '*.ts' needle src/" });
  policyCase('rg -n "two words" .', "translate", { action: "rewrite", command: "tgrep -n 'two words' ." });
  policyCase('grep -rl "IBehavior<" src --include="*.cs" | head -50', "translate", {
    action: "rewrite",
    command: "tgrep -l -g '*.cs' 'IBehavior<' src | head -50",
  });
  policyCase("tgrep -l 'IBehavior<' src 2>/dev/null | grep -v '\\.Tests' | sort", "translate", {
    action: "allow",
  });
  policyCase("cat f | grep needle", "translate", { action: "allow" });
  policyCase("grep needle file.txt | wc -l", "translate", {
    action: "rewrite",
    command: "tgrep needle file.txt | wc -l",
  });
  policyCase("rg foo . > out.txt", "translate", { action: "rewrite", command: "tgrep foo . > out.txt" });
  policyCase("grep foo .; rm x", "translate", { action: "block" });
  policyCase("echo $(rg foo .)", "translate", { action: "block" });
  policyCase("grep foo < in.txt", "translate", { action: "block" });
  policyCase("grep -rn --include=*.ts needle .", "translate", {
    action: "rewrite",
    command: "tgrep -n -g '*.ts' needle .",
  });
  policyCase("zgrep needle x.log", "translate", { action: "allow" });
  policyCase("git log --grep needle", "translate", { action: "allow" });
  // BRE-only patterns run verbatim: original grep preserves exact semantics
  policyCase("grep 'a\\(b\\)' f", "translate", { action: "allow" });
  policyCase("rg --files", "translate", { action: "rewrite", command: "tgrep --files" });
  policyCase("sudo grep -i needle /etc/hosts", "translate", {
    action: "rewrite",
    command: "sudo tgrep -i needle /etc/hosts",
  });
  policyCase("grep -rn needle .", "block", { action: "block" });
  policyCase("rg -n needle .", "off", { action: "allow" });
  policyCase("grep -rn needle .", "warn", { action: "warn", command: "grep -rn needle ." });
  policyCase("ls src/", "translate", { action: "allow" });
  // ag/ack/pt run untranslated: flag semantics diverge from rg/tgrep, slow but correct
  policyCase("ag -l needle", "translate", { action: "allow" });
  policyCase("grep --exclude-dir=node_modules -r needle .", "translate", {
    action: "rewrite",
    command: "tgrep -g '!node_modules/**' needle .",
  });
  policyCase("fgrep -n 'a.b' .", "translate", { action: "rewrite", command: "tgrep -F -n a.b ." });
  policyCase("egrep 'ab+c' .", "translate", { action: "rewrite", command: "tgrep ab+c ." });
  policyCase(
    'cd /Users/danielmarbach/Projects/NServiceBus && grep -rl "IBehavior<" src --include="*.cs" | head -50',
    "translate",
    {
      action: "rewrite",
      command: "cd /Users/danielmarbach/Projects/NServiceBus && tgrep -l -g '*.cs' 'IBehavior<' src | head -50",
    },
  );
  policyCase("cd /a && cd /b && rg -n foo .", "translate", {
    action: "rewrite",
    command: "cd /a && cd /b && tgrep -n foo .",
  });
  policyCase("cd /x; grep foo .", "translate", { action: "rewrite", command: "cd /x; tgrep foo ." });
  policyCase('cd "$(pwd)" && grep foo .', "translate", { action: "block" });
  policyCase("echo hi && grep foo .", "translate", { action: "block" });
  policyCase(
    "grep -rniE --include=\"*.cs\" '^\\s*(public\\s+)?class' src/NServiceBus.Core 2>/dev/null | grep -v \"/obj/\" | sed \"s|x|y|\" | sort",
    "translate",
    {
      action: "rewrite",
      command:
        "tgrep -n -i -g '*.cs' '^\\s*(public\\s+)?class' src/NServiceBus.Core 2>/dev/null | grep -v \"/obj/\" | sed \"s|x|y|\" | sort",
    },
  );
  policyCase("rg foo . 2>&1", "translate", { action: "rewrite", command: "tgrep foo . 2>&1" });
  policyCase("rg foo . 2>>run.log", "translate", { action: "rewrite", command: "tgrep foo . 2>>run.log" });
  policyCase("grep foo file2>out.txt", "translate", { action: "rewrite", command: "tgrep foo file2 >out.txt" });
  policyCase("cd /x && grep foo . 2>/dev/null", "translate", {
    action: "rewrite",
    command: "cd /x && tgrep foo . 2>/dev/null",
  });
  console.log("policy tests ok");
}

async function runRedirectExecTest() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-redirect-"));
  await mkdir(path.join(dir, "src/NServiceBus.Core"), { recursive: true });
  await writeFile(path.join(dir, "src/NServiceBus.Core/Host.cs"), "public class Host {}\nclass Other {}\n");
  const command =
    "grep -rniE --include=\"*.cs\" '^\\s*(public\\s+)?class' src/NServiceBus.Core 2>/dev/null | grep -v \"/obj/\" | sed \"s|x|y|\" | sort";
  const result = applyBashPolicy(command, "translate");
  assert.equal(result.action, "rewrite");
  assert.ok(result.command.includes("2>/dev/null"), "fd redirect must stay glued");
  assert.ok(!result.command.includes(" 2 >"), "fd digit must not leak as a tgrep path");
  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileP("bash", ["-c", result.command], { cwd: dir, encoding: "utf8" });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err) {
    code = typeof err.code === "number" ? err.code : 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }
  assert.equal(code, 0, `rewritten command failed (code ${code}): ${stderr}`);
  assert.ok(stdout.includes("Host.cs"), `expected matches, got: ${stdout}`);
  assert.ok(!stderr.includes("IO error"), `unexpected IO error: ${stderr}`);
  await rm(dir, { recursive: true, force: true });
  console.log("redirect exec test ok");
}

function runWatchedToolsTests() {
  const watched = ["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"];

  let input = { language: "shell", code: "grep -rl foo src | head" };
  let r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.code, "tgrep -l foo src | head");

  input = { language: "javascript", code: "const grep = 'grep foo';" };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "allow");
  assert.equal(input.code, "const grep = 'grep foo';");

  input = { language: "shell", code: "echo start\ngrep -rl foo src | head\necho done" };
  r = applyToolCallPolicy("ctx_execute_file", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.code, "echo start\ntgrep -l foo src | head\necho done");

  input = { commands: [{ label: "list", command: "ls src/" }, { label: "scan", command: "rg -n x ." }] };
  r = applyToolCallPolicy("ctx_batch_execute", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.commands[0].command, "ls src/");
  assert.equal(input.commands[1].command, "tgrep -n x .");

  input = { commands: [{ label: "cleanup", command: "grep foo .; rm x" }] };
  r = applyToolCallPolicy("ctx_batch_execute", input, "translate", watched);
  assert.equal(r.action, "block");
  assert.match(r.reason ?? "", /cleanup/);

  input = { language: "shell", code: "grep -rl foo src" };
  r = applyToolCallPolicy("mcp__context-mode__ctx_execute", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.code, "tgrep -l foo src");

  const heredoc = "cat > filter.sh <<'EOF'\ngrep -rl foo src | head\nEOF";
  input = { language: "shell", code: heredoc };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "allow");
  assert.equal(input.code, heredoc);

  const heredocThenGrep = "cat > f <<EOF\nhi\nEOF\ngrep -rl foo src";
  input = { language: "shell", code: heredocThenGrep };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "block");

  process.env.PI_TGREP_WATCH_TOOLS = "custom_tool";
  const cfg = loadConfig();
  assert.ok(cfg.watchedTools.includes("custom_tool"));
  input = { command: "grep -rn foo ." };
  r = applyToolCallPolicy("custom_tool", input, "translate", cfg.watchedTools);
  assert.equal(r.action, "rewrite");
  assert.equal(input.command, "tgrep -n foo .");
  delete process.env.PI_TGREP_WATCH_TOOLS;

  input = { language: "shell", code: "cd /repo && grep -rl needle src | head -3" };
  r = applyToolCallPolicy("ctx_execute", input, "translate");
  assert.equal(r.action, "rewrite");
  assert.equal(input.code, "cd /repo && tgrep -l needle src | head -3");

  input = { command: "grep -rn needle src" };
  r = applyToolCallPolicy("bash", input, "translate", watched, { indexPath: "/repo/.tgrep" });
  assert.equal(r.action, "rewrite");
  assert.equal(input.command, "tgrep --index-path '/repo/.tgrep' -n needle src");

  input = { command: "grep -rn needle src" };
  r = applyToolCallPolicy("bash", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.command, "tgrep -n needle src");

  input = { command: "rg foo /etc" };
  r = applyToolCallPolicy("bash", input, "translate", watched, { indexPath: "/repo/.tgrep" });
  assert.equal(r.action, "rewrite");
  assert.equal(input.command, "tgrep foo /etc");

  input = { command: "rg --index-path /custom -n foo src" };
  r = applyToolCallPolicy("bash", input, "translate", watched, { indexPath: "/repo/.tgrep" });
  assert.equal(r.action, "rewrite");
  assert.ok(!input.command.includes("'/repo/.tgrep'"), "must not double-inject --index-path");

  input = { language: "javascript", code: "const out = execSync(`grep -rn foo .`);" };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.code, "const out = execSync(`tgrep -n foo .`);");

  input = { language: "javascript", code: 'exec("grep -rl foo src");' };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.code, 'exec("tgrep -l foo src");');

  input = { language: "javascript", code: "execSync('grep -rn foo .');" };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "block");
  assert.match(r.reason ?? "", /bypasses the tgrep index/);

  input = { language: "javascript", code: "execSync('ls -la');" };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "allow");

  input = { language: "javascript", code: "// grep stuff\nls();" };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "allow");

  input = { language: "javascript", code: "execSync(cmd);" };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "block");

  input = { language: "javascript", code: "execSync(`grep ${name} .`);" };
  r = applyToolCallPolicy("ctx_execute", input, "translate", watched);
  assert.equal(r.action, "block");

  input = { language: "javascript", code: "const out = spawnSync('grep -rn foo .');" };
  r = applyToolCallPolicy("ctx_execute_file", input, "translate", watched);
  assert.equal(r.action, "block");

  console.log("watched tools tests ok");
}

function runGrepArgsTests(repoDir) {
  const sub = path.join(repoDir, "src");
  const idx = { root: repoDir, indexDirExists: true };
  const subpath = buildTgrepArgs({ pattern: "needle" }, sub, idx);
  assert.ok(subpath.includes("--index-path"), "subpath search with index must inject --index-path");
  assert.ok(subpath.includes(path.join(repoDir, ".tgrep")));
  const atRoot = buildTgrepArgs({ pattern: "needle" }, repoDir, idx);
  assert.ok(atRoot.includes("--index-path"), "root search with index must inject --index-path");
  const outside = buildTgrepArgs({ pattern: "needle" }, "/etc", idx);
  assert.ok(!outside.includes("--index-path"), "search outside root must not inject");
  const noIndexDir = buildTgrepArgs({ pattern: "needle" }, sub, { root: repoDir, indexDirExists: false });
  assert.ok(!noIndexDir.includes("--index-path"), "missing index dir must not inject");
  const noRoot = buildTgrepArgs({ pattern: "needle" }, sub);
  assert.ok(!noRoot.includes("--index-path"), "no root context must not inject");
  console.log("grep args tests ok");
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
  await runRedirectExecTest();
  runWatchedToolsTests();
  runGrepArgsTests(repoDir);
  await runGrepToolTests(repoDir);
  await runServerManagerTests(repoDir);
} finally {
  await rm(repoDir, { recursive: true, force: true });
}
console.log("ALL HARNESS TESTS PASSED");
