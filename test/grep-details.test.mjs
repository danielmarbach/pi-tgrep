import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  resetBinaryCache();
  const literalTool = createGrepToolOverride(makePi());
  await mkdir(path.join(repoDir, "tests"), { recursive: true });
  await writeFile(path.join(repoDir, "tests", "gen.ts"), "Generate(x)\nHandle(Foo|Bar\n");

  const regexRetry = await literalTool.execute("d6", { pattern: "Generate(" }, undefined, undefined, ctx);
  assert.equal(regexRetry.details.engine, "tgrep");
  assert.equal(regexRetry.details.regexFallback, true);
  assert.equal(regexRetry.details.fallback, undefined);
  assert.match(regexRetry.content[0].text, /tests\/gen\.ts:1: Generate\(x\)/);
  assert.match(regexRetry.content[0].text, /\[pi-tgrep\] pattern is not a valid regex; searched literally$/);
  const unbalanced = await literalTool.execute("d7", { pattern: "Handle(Foo|Bar" }, undefined, undefined, ctx);
  assert.equal(unbalanced.details.regexFallback, true);
  assert.match(unbalanced.content[0].text, /tests\/gen\.ts:2: Handle\(Foo\|Bar/);
  const regexMiss = await literalTool.execute("d8", { pattern: "NoSuchThing(" }, undefined, undefined, ctx);
  assert.match(regexMiss.content[0].text, /^No matches found\n\n\[pi-tgrep\] pattern is not a valid regex/);
  const validRegex = await literalTool.execute("d9", { pattern: "needl[e]" }, undefined, undefined, ctx);
  assert.equal(validRegex.details.regexFallback, undefined);
  assert.doesNotMatch(validRegex.content[0].text, /pi-tgrep\]/);
  console.log("invalid regex literal retry ok");

  const multi = await literalTool.execute("d10", { pattern: "needle", path: "src tests/gen.ts" }, undefined, undefined, ctx);
  assert.equal(multi.details.engine, "tgrep");
  assert.equal(multi.details.searchPaths.length, 2);
  assert.match(multi.content[0].text, /^src\/app\.ts:\d+: /m);
  const multiDirs = await literalTool.execute("d11", { pattern: "Generate\\(", path: "src tests" }, undefined, undefined, ctx);
  assert.match(multiDirs.content[0].text, /^tests\/gen\.ts:1: Generate\(x\)$/m);
  const halfMissing = literalTool.execute("d12", { pattern: "needle", path: "src nope-dir" }, undefined, undefined, ctx);
  await assert.rejects(halfMissing, /^Error: Path not found: .*src nope-dir/);
  console.log("multi-path string ok");

  await assert.rejects(
    literalTool.execute("d13", { pattern: "needle", path: "src/missing/deeper" }, undefined, undefined, ctx),
    (err) => {
      const lines = err.message.split("\n");
      assert.equal(lines[0], `Path not found: ${path.join(repoDir, "src", "missing", "deeper")}`);
      assert.match(lines[1], /Nearest existing directory: .*\/src$/);
      assert.match(lines[2], /^Entries: .*app\.ts/);
      return true;
    },
  );
  const wide = path.join(repoDir, "wide");
  await mkdir(wide);
  for (let i = 0; i < 25; i++) await writeFile(path.join(wide, `f${String(i).padStart(2, "0")}.txt`), "x\n");
  await assert.rejects(literalTool.execute("d14", { pattern: "x", path: "wide/nope" }, undefined, undefined, ctx), (err) => {
    const entries = err.message.split("\n")[2].replace(/^Entries: /, "");
    assert.match(entries, /f19\.txt, … \(5 more\)$/);
    assert.equal(entries.split(", ").length, 21);
    return true;
  });
  console.log("path-not-found recovery info ok");

  const fakeTgrep = path.join(repoDir, "fake-tgrep.sh");
  await writeFile(
    fakeTgrep,
    "#!/bin/sh\necho 'warning: no index at /x - scanning every file' >&2\necho 'tgrep: boom: index is corrupt' >&2\nexit 2\n",
    { mode: 0o755 },
  );
  resetBinaryCache();
  await assert.rejects(
    createGrepToolOverride(
      makePi({ whichResult: { stdout: `${fakeTgrep}\n`, stderr: "", code: 0, killed: false } }),
    ).execute("d15", { pattern: "(", path: "src" }, undefined, undefined, ctx),
    /^Error: tgrep: boom: index is corrupt$/,
  );
  console.log("tgrep stderr surfaced when fallback fails ok");
} finally {
  resetBinaryCache();
  await rm(repoDir, { recursive: true, force: true });
}
console.log("ALL GREP DETAILS TESTS PASSED");
