import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGrepToolOverride } from "../src/grep-tool.ts";
import { resetBinaryCache } from "../src/tgrep-client.ts";

const execFileP = promisify(execFile);

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/repo");

const INDEXING_STATUS = [
  "Server status for /tmp/fake",
  "PID: 12345",
  "Port: 4567",
  "Files: 100",
  "Watcher: active",
  "Indexing: in progress",
  "",
].join("\n");

function makePi({ whichResult, statusText } = {}) {
  return {
    async exec(command, args, options = {}) {
      if (command === "which" && args[0] === "tgrep" && whichResult !== undefined) {
        return whichResult;
      }
      if (command === "tgrep" && args[0] === "status" && statusText !== undefined) {
        return { stdout: statusText, stderr: "", code: 0, killed: false };
      }
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
}

const repoDir = await mkdtemp(path.join(tmpdir(), "pi-tgrep-details-"));
await cp(FIXTURE, repoDir, { recursive: true });
await execFileP("git", ["init"], { cwd: repoDir });

const ctx = { cwd: repoDir, ui: {} };

try {
  resetBinaryCache();
  const tool = createGrepToolOverride(makePi());

  const plain = await tool.execute("d1", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(plain.details.engine, "tgrep");
  assert.equal(plain.details.fallback, undefined);
  assert.equal(plain.details.truncated, undefined);
  assert.match(plain.content[0].text, /src\/app\.ts:\d+: /);
  console.log("indexed success details ok");

  const limited = await tool.execute("d2", { pattern: "needle", limit: 1 }, undefined, undefined, ctx);
  assert.equal(limited.details.matchLimitReached, 1);
  assert.equal(limited.details.truncated, true);
  assert.match(limited.content[0].text, /1 matches limit reached/);
  console.log("truncated details ok");

  resetBinaryCache();
  const indexing = await createGrepToolOverride(makePi({ statusText: INDEXING_STATUS })).execute(
    "d3",
    { pattern: "needle" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(indexing.details.engine, "rg-fallback");
  assert.equal(indexing.details.fallback.reason, "indexing");
  assert.ok(indexing.details.fallback.message, "indexing fallback must carry a message");
  assert.match(indexing.content[0].text, /src\/app\.ts/);
  console.log("fallback-while-indexing details ok");

  resetBinaryCache();
  const errored = await createGrepToolOverride(
    makePi({ whichResult: { stdout: "/nonexistent/pi-tgrep-missing-tgrep\n", stderr: "", code: 0, killed: false } }),
  ).execute("d4", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(errored.details.engine, "rg-fallback");
  assert.equal(errored.details.fallback.reason, "error");
  assert.match(errored.details.fallback.message, /nonexistent|ENOENT|spawn/i);
  assert.match(errored.content[0].text, /src\/app\.ts/);
  console.log("fallback-on-error details ok");

  resetBinaryCache();
  const noBinary = await createGrepToolOverride(
    makePi({ whichResult: { stdout: "", stderr: "", code: 1, killed: false } }),
  ).execute("d5", { pattern: "needle" }, undefined, undefined, ctx);
  assert.equal(noBinary.details.engine, "rg-fallback");
  assert.equal(noBinary.details.fallback.reason, "no-binary");
  assert.match(noBinary.content[0].text, /src\/app\.ts/);
  console.log("fallback-no-binary details ok");
} finally {
  resetBinaryCache();
  await rm(repoDir, { recursive: true, force: true });
}
console.log("ALL GREP DETAILS TESTS PASSED");
