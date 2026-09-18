import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import piTgrep from "../extensions/index.ts";

const execFileP = promisify(execFile);
const FIXTURE = path.resolve(import.meta.dirname, "fixtures/repo");

delete process.env.PI_TGREP_DISABLED;
delete process.env.PI_TGREP_BASH_POLICY;
delete process.env.PI_TGREP_WATCH_TOOLS;
delete process.env.PI_TGREP_INDEX_PATH;
process.env.PI_TGREP_AUTO_INSTALL = "never";

function makePi() {
  const handlers = {};
  return {
    handlers,
    tools: [],
    commands: [],
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool(tool) {
      this.tools.push(tool);
    },
    registerCommand(name) {
      this.commands.push(name);
    },
    async exec() {
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
  };
}

const repoDir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-provenance-"));
await cp(FIXTURE, repoDir, { recursive: true });
await execFileP("git", ["init"], { cwd: repoDir });
// An existing index dir is what lets the policy point rewritten greps at it.
await mkdir(path.join(repoDir, ".tgrep"));
after(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

const IDX_PATH = path.join(repoDir, ".tgrep");

const pi = makePi();
piTgrep(pi);
const ctx = { cwd: repoDir, ui: {} };
const onToolCall = pi.handlers.tool_call[0];
const onToolResult = pi.handlers.tool_result[0];

assert.ok(onToolCall, "extension must register a tool_call handler");
assert.ok(onToolResult, "extension must register a tool_result handler");

async function toolCall(id, toolName, input) {
  const event = { type: "tool_call", toolCallId: id, toolName, input };
  const res = await onToolCall(event, ctx);
  return { event, res };
}

async function toolResult(id, toolName, details) {
  return onToolResult(
    {
      type: "tool_result",
      toolCallId: id,
      toolName,
      input: {},
      content: [{ type: "text", text: "out" }],
      details,
      isError: false,
    },
    ctx,
  );
}

test("translated bash command stamps the tool result", async () => {
  const { event, res } = await toolCall("p1", "bash", { command: "rg -n needle src/" });
  assert.equal(res, undefined, "rewrite must not block");
  assert.equal(event.input.command, `tgrep search --index-path '${IDX_PATH}' -n needle src/`);
  const patch = await toolResult("p1", "bash", undefined);
  assert.deepEqual(patch, {
    details: { engine: "tgrep", command: `tgrep search --index-path '${IDX_PATH}' -n needle src/`, original: "rg -n needle src/" },
  });
  console.log("translated stamp ok");
});

test("non-grep bash command passes through unstamped", async () => {
  const { event } = await toolCall("p2", "bash", { command: "ls -la src/" });
  assert.equal(event.input.command, "ls -la src/");
  assert.equal(await toolResult("p2", "bash", undefined), undefined);
  console.log("unstamped passthrough ok");
});

test("pipeline translation stamps the rewritten full command", async () => {
  const { event } = await toolCall("p3", "bash", { command: "cat f | grep -n needle src | wc -l" });
  assert.equal(event.input.command, `cat f | tgrep search --index-path '${IDX_PATH}' -n needle src | wc -l`);
  const patch = await toolResult("p3", "bash", { fullOutputPath: "/tmp/out.txt" });
  assert.equal(patch.details.engine, "tgrep");
  assert.equal(patch.details.command, `cat f | tgrep search --index-path '${IDX_PATH}' -n needle src | wc -l`);
  assert.equal(patch.details.original, "cat f | grep -n needle src | wc -l");
  assert.equal(patch.details.fullOutputPath, "/tmp/out.txt", "existing bash details must be preserved");
  console.log("pipeline stamp ok");
});

test("blocked bash commands leave no stamp", async () => {
  const { res } = await toolCall("p4", "bash", { command: "grep -d skip foo ." });
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /bypasses the tgrep index/);
  assert.equal(await toolResult("p4", "bash", undefined), undefined);
  console.log("blocked unstamped ok");
});

test("compound command stamps the rewritten full command", async () => {
  const { event, res } = await toolCall("p6", "bash", { command: "grep foo .; rm x" });
  assert.equal(res, undefined, "compound with a translatable search part must not block");
  assert.equal(event.input.command, `tgrep search --index-path '${IDX_PATH}' foo . ; rm x`);
  const patch = await toolResult("p6", "bash", undefined);
  assert.deepEqual(patch, {
    details: { engine: "tgrep", command: `tgrep search --index-path '${IDX_PATH}' foo . ; rm x`, original: "grep foo .; rm x" },
  });
  console.log("compound stamp ok");
});

test("non-bash watched rewrites do not stamp bash results", async () => {
  const { event } = await toolCall("p5", "ctx_execute", { language: "shell", code: "grep -rn foo src" });
  assert.equal(event.input.code, `tgrep search --index-path '${IDX_PATH}' -n foo src`);
  assert.equal(await toolResult("p5", "bash", undefined), undefined);
  console.log("non-bash unstamped ok");
});

test("bash tool is not re-registered (schema untouched)", () => {
  assert.equal(pi.tools.length, 0, "no session_start fired, and bash is never overridden");
  console.log("no bash re-registration ok");
});
