import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig, resolveIndexPath } from "../src/config.ts";
import { buildTgrepArgs, createGrepToolOverride } from "../src/grep-tool.ts";
import { ServerManager } from "../src/server-manager.ts";
import { pidAlive, resetBinaryCache, status } from "../src/tgrep-client.ts";
import piTgrep from "../extensions/index.ts";

const execFileP = promisify(execFile);
const FIXTURE = path.resolve(import.meta.dirname, "fixtures/repo");

const ENV_KEYS = [
  "PI_TGREP_DISABLED",
  "PI_TGREP_AUTO_INSTALL",
  "PI_TGREP_BASH_POLICY",
  "PI_TGREP_SERVE_ARGS",
  "PI_TGREP_INDEX_PATH",
  "PI_TGREP_SCOPE",
  "PI_TGREP_WATCH_TOOLS",
];

function setEnv(overrides) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeFakePi(commandOverrides = {}) {
  const calls = [];
  const pi = {
    calls,
    handlers: {},
    on(event, handler) {
      pi.handlers[event] = handler;
    },
    registerTool(tool) {
      calls.push({ kind: "registerTool", name: tool.name });
    },
    registerCommand(name) {
      calls.push({ kind: "registerCommand", name });
    },
    async exec(command, args, options = {}) {
      calls.push({ kind: "exec", command, args });
      const override = commandOverrides[command];
      if (override) return typeof override === "function" ? override(args) : override;
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
  return pi;
}

function makeUi(calls) {
  return {
    confirm: async (...args) => {
      calls.push({ kind: "confirm", args });
      return true;
    },
    setStatus: (key, value) => calls.push({ kind: "setStatus", key, value }),
    notify: (...args) => calls.push({ kind: "notify", args }),
  };
}

async function makeTempRepo(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await cp(FIXTURE, dir, { recursive: true });
  await execFileP("git", ["init"], { cwd: dir });
  return dir;
}

test("PI_TGREP_SCOPE=session shutdown stops the spawned server", async () => {
  const saved = setEnv({ PI_TGREP_SCOPE: "session" });
  const dir = await makeTempRepo("pi-tgrep-lifecycle-");
  const pi = makeFakePi();
  let manager;
  try {
    const cfg = loadConfig();
    assert.equal(cfg.scope, "session");
    manager = new ServerManager(pi, cfg);

    const st = await manager.ensureRunning(dir);
    assert.equal(st.kind, "server", `expected server, got ${JSON.stringify(st)}`);
    assert.equal(st.indexingComplete, true);
    assert.ok(st.pid > 0, "status must report the spawned pid");
    assert.ok(pidAlive(st.pid), "spawned server must be alive before shutdown");

    await manager.shutdown();

    assert.ok(!pidAlive(st.pid), "shutdown must kill the spawned server");
    const after = await status(pi, dir);
    assert.equal(after.kind, "index", `expected index-only after shutdown, got ${JSON.stringify(after)}`);
    assert.ok(!existsSync(path.join(dir, ".tgrep", "serve.json")), "stale serve.json must be removed");
  } finally {
    await manager?.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    restoreEnv(saved);
  }
});

test("PI_TGREP_AUTO_INSTALL=never stays dormant without prompting", async () => {
  const saved = setEnv({ PI_TGREP_AUTO_INSTALL: "never" });
  const dir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-nogit-"));
  resetBinaryCache();
  const pi = makeFakePi({
    which: () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    brew: () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  });
  const uiCalls = [];
  try {
    piTgrep(pi);
    assert.ok(pi.handlers.session_start, "extension must subscribe to session_start");
    await pi.handlers.session_start({}, { cwd: dir, hasUI: true, ui: makeUi(uiCalls) });

    assert.ok(!pi.calls.some((c) => c.kind === "exec" && c.command === "brew"), "never must not run brew");
    assert.ok(!pi.calls.some((c) => c.kind === "registerTool"), "missing binary + never must stay dormant");
    assert.ok(!uiCalls.some((c) => c.kind === "confirm"), "never must not prompt");
  } finally {
    resetBinaryCache();
    await rm(dir, { recursive: true, force: true });
    restoreEnv(saved);
  }
});

test("PI_TGREP_AUTO_INSTALL=always installs via brew without prompting", async () => {
  const saved = setEnv({ PI_TGREP_AUTO_INSTALL: "always" });
  const dir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-nogit-"));
  resetBinaryCache();
  let tgrepInstalled = false;
  const pi = makeFakePi({
    which: () =>
      tgrepInstalled
        ? { stdout: "/opt/homebrew/bin/tgrep\n", stderr: "", code: 0, killed: false }
        : { stdout: "", stderr: "", code: 1, killed: false },
    brew: () => {
      tgrepInstalled = true;
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  });
  const uiCalls = [];
  try {
    piTgrep(pi);
    await pi.handlers.session_start({}, { cwd: dir, hasUI: true, ui: makeUi(uiCalls) });

    const brewCalls = pi.calls.filter((c) => c.kind === "exec" && c.command === "brew");
    assert.equal(brewCalls.length, 1, "always must attempt exactly one brew install");
    assert.deepEqual(brewCalls[0].args, ["install", "tgrep"]);
    assert.ok(!uiCalls.some((c) => c.kind === "confirm"), "always must bypass the interactive prompt");
    const registered = pi.calls.filter((c) => c.kind === "registerTool");
    assert.equal(registered.length, 1, "grep override must register after install");
    assert.equal(registered[0].name, "grep");
  } finally {
    resetBinaryCache();
    await rm(dir, { recursive: true, force: true });
    restoreEnv(saved);
  }
});

test("PI_TGREP_INDEX_PATH override reaches server args and tool args", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "pi-tgrep-indexpath-"));
  const dir = path.join(work, "repo");
  await cp(FIXTURE, dir, { recursive: true });
  await execFileP("git", ["init"], { cwd: dir });
  const customIdx = path.join(work, "custom-index");
  await mkdir(customIdx, { recursive: true });

  const saved = setEnv({ PI_TGREP_INDEX_PATH: customIdx, PI_TGREP_SCOPE: "session" });
  const pi = makeFakePi();
  const manager = new ServerManager(pi, loadConfig());
  try {
    const st = await manager.ensureRunning(dir);
    assert.equal(st.kind, "server", `expected server via custom index dir, got ${JSON.stringify(st)}`);
    assert.equal(st.indexingComplete, true);
    assert.ok(existsSync(path.join(customIdx, "serve.json")), "serve args must pin serve.json to the override dir");
    assert.ok(!existsSync(path.join(dir, ".tgrep")), "default .tgrep dir must not be created when override is set");

    const toolArgs = buildTgrepArgs({ pattern: "needle" }, dir, { root: dir, indexDirExists: true });
    const idx = toolArgs.indexOf("--index-path");
    assert.notEqual(idx, -1, "tool args must include --index-path");
    assert.equal(toolArgs[idx + 1], resolveIndexPath(dir));
    assert.equal(toolArgs[idx + 1], customIdx);

    const tool = createGrepToolOverride(pi);
    const res = await tool.execute("t1", { pattern: "needle" }, undefined, undefined, { cwd: dir, ui: {} });
    assert.equal(res.details.engine, "tgrep");
    assert.match(res.content[0].text, /src\/app\.ts:\d+: /);

    await manager.shutdown();
    assert.ok(!pidAlive(st.pid), "shutdown must kill the custom-index server");
    const after = await status(pi, dir, resolveIndexPath(dir));
    assert.equal(after.kind, "index", `expected index-only after shutdown, got ${JSON.stringify(after)}`);
  } finally {
    await manager.shutdown().catch(() => {});
    await rm(work, { recursive: true, force: true });
    restoreEnv(saved);
  }
});
