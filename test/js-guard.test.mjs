import assert from "node:assert/strict";
import { applyToolCallPolicy } from "../src/watched-tools.ts";

const IDX = { indexPath: "/repo/.tgrep" };
const watched = ["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"];

async function jsCase(code, expect) {
  const input = { language: "javascript", code };
  const r = await applyToolCallPolicy("ctx_execute", input, "translate", watched, IDX);
  assert.equal(r.action, expect.action, `code: ${code}`);
  if (expect.action === "block" && expect.reasonMatch) {
    assert.match(r.reason ?? "", expect.reasonMatch, `code: ${code}`);
  }
  if (expect.action === "rewrite" && expect.code) {
    assert.equal(input.code, expect.code, `code: ${code}`);
  }
  return r;
}

async function run() {
  // RegExp.prototype.exec on a variable whose first arg can't be extracted, and no child_process
  // reference anywhere: the member call is never treated as a child_process call.
  await jsCase(
    "const fs = require('fs');\n" +
      "const line = fs.readFileSync('x', 'utf8');\n" +
      "let m;\n" +
      "const r2 = /(\\.Map|\\.Info)(\\??\\.([A-Za-z_]+)|\\[)/g;\n" +
      "while ((m = r2.exec(line))) { console.log(m[0]); }",
    { action: "allow" },
  );

  // child_process is imported, but the .exec() call is on an unrelated regex variable.
  await jsCase(
    "const cp = require('child_process');\n" +
      "const re = /foo/g;\n" +
      "let m;\n" +
      "while ((m = re.exec(line))) { console.log(m[0]); }",
    { action: "allow" },
  );

  // cp bound to child_process via require(): member call with a backtick arg rewrites in place.
  await jsCase("const cp = require('child_process'); cp.execSync(`grep -rn foo src`);", {
    action: "rewrite",
    code: "const cp = require('child_process'); cp.execSync(`tgrep search --index-path '/repo/.tgrep' -n foo src`);",
  });

  // cp bound via import * as / default import forms.
  await jsCase("import * as cp from 'child_process'; cp.execSync(`grep -rn foo src`);", {
    action: "rewrite",
    code: "import * as cp from 'child_process'; cp.execSync(`tgrep search --index-path '/repo/.tgrep' -n foo src`);",
  });
  await jsCase("import cp from 'node:child_process'; cp.exec(`grep -rn foo src`);", {
    action: "rewrite",
    code: "import cp from 'node:child_process'; cp.exec(`tgrep search --index-path '/repo/.tgrep' -n foo src`);",
  });

  // Chained require().execSync(...) receiver is recognized as child_process directly.
  await jsCase("require('child_process').execSync(`grep -rn foo src`);", {
    action: "rewrite",
    code: "require('child_process').execSync(`tgrep search --index-path '/repo/.tgrep' -n foo src`);",
  });

  // Bare destructured execSync stays guarded as today even though the arg is a variable, because
  // FAMILY_PATTERN matches elsewhere in the code (the literal grep command assigned to cmd).
  await jsCase(
    "const {execSync}=require('child_process'); const cmd='grep -rn foo src'; execSync(cmd);",
    { action: "block", reasonMatch: /bypasses the tgrep index/ },
  );

  // Same shape, but nothing in the code mentions grep anywhere: allowed.
  await jsCase("const {execSync}=require('child_process'); const cmd=getCommand(); execSync(cmd);", {
    action: "allow",
  });

  // Bare call with no grep anywhere in the code at all.
  await jsCase("execSync(cmd);", { action: "allow" });

  // Bare call to a non-grep command stays allowed.
  await jsCase("execSync('ls');", { action: "allow" });

  // Member call on an identifier not bound to child_process, with a grep-family literal:
  // never treated as a child_process call, regardless of content.
  await jsCase("const runner = getRunner(); runner.exec('grep -rn foo src');", { action: "allow" });

  console.log("js child_process guard tests ok");
}

await run();
console.log("ALL JS GUARD TESTS PASSED");
