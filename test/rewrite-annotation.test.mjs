import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import piTgrep from "../extensions/index.ts";
import { buildRewriteNote } from "../src/rewrite-annotation.ts";

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

const repoDir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-annotation-"));
await cp(FIXTURE, repoDir, { recursive: true });
await execFileP("git", ["init"], { cwd: repoDir });
// An existing index dir is what lets the policy point rewritten greps at it.
await mkdir(path.join(repoDir, ".tgrep"));
after(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

const IDX_PATH = path.join(repoDir, ".tgrep");
const REWRITTEN_COMMAND = `tgrep search --index-path '${IDX_PATH}' -n needle src/`;
const ORIGINAL_COMMAND = "rg -n needle src/";

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

async function toolResult(id, toolName, { content = [{ type: "text", text: "out" }], details, isError = false } = {}) {
  return onToolResult(
    {
      type: "tool_result",
      toolCallId: id,
      toolName,
      input: {},
      content,
      details,
      isError,
    },
    ctx,
  );
}

test("empty output on a rewritten command gets an annotation", async () => {
  const { res } = await toolCall("a1", "bash", { command: ORIGINAL_COMMAND });
  assert.equal(res, undefined);
  const patch = await toolResult("a1", "bash", { content: [{ type: "text", text: "(no output)" }] });
  assert.equal(patch.content.length, 2);
  assert.equal(patch.content[0].text, "(no output)");
  assert.equal(patch.content[1].text, `[pi-tgrep] ran \`${REWRITTEN_COMMAND}\` in place of \`${ORIGINAL_COMMAND}\``);
  assert.equal(patch.details.engine, "tgrep");
  console.log("empty output annotated ok");
});

test("error result on a rewritten command gets an annotation", async () => {
  await toolCall("a2", "bash", { command: ORIGINAL_COMMAND });
  const patch = await toolResult("a2", "bash", { content: [{ type: "text", text: "some failure" }], isError: true });
  assert.equal(patch.content.length, 2);
  assert.equal(patch.content[0].text, "some failure");
  assert.equal(patch.content[1].text, `[pi-tgrep] ran \`${REWRITTEN_COMMAND}\` in place of \`${ORIGINAL_COMMAND}\``);
  console.log("error result annotated ok");
});

test("normal non-empty output on a rewritten command stays unchanged", async () => {
  await toolCall("a3", "bash", { command: ORIGINAL_COMMAND });
  const patch = await toolResult("a3", "bash", { content: [{ type: "text", text: "src/needle.ts:1:needle" }] });
  assert.equal(patch.content, undefined, "content must be left untouched when output is non-empty");
  assert.equal(patch.details.engine, "tgrep");
  console.log("normal output unchanged ok");
});

test("non-rewritten command result is untouched even with empty output", async () => {
  await toolCall("a4", "bash", { command: "ls -la src/" });
  const patch = await toolResult("a4", "bash", { content: [{ type: "text", text: "(no output)" }] });
  assert.equal(patch, undefined);
  console.log("non-rewritten passthrough ok");
});

test("long commands are truncated in the annotation", () => {
  const longCommand = `tgrep search ${"n".repeat(300)}`;
  const note = buildRewriteNote(longCommand, "grep -n foo");
  assert.match(note, /…`/, "truncated command must end with an ellipsis before the closing backtick");
  assert.ok(note.length < longCommand.length, "note must be shorter than the untruncated command");
  console.log("long command truncation ok");
});
