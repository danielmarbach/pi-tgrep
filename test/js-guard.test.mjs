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

// The translated literal must evaluate to the expected shell command, not merely look right.
async function literalCase(literal, expectedCommand, { prefix = "execSync(", suffix = ", {cwd:R});" } = {}) {
  const code = prefix + literal + suffix;
  const input = { language: "javascript", code };
  const r = await applyToolCallPolicy("ctx_execute", input, "translate", watched, IDX);
  assert.equal(r.action, "rewrite", `code: ${code}`);
  assert.ok(input.code.startsWith(prefix) && input.code.endsWith(suffix), `surroundings intact: ${input.code}`);
  const newLiteral = input.code.slice(prefix.length, input.code.length - suffix.length);
  assert.equal(new Function("return " + newLiteral)(), expectedCommand, `code: ${code}`);
  assert.equal(newLiteral[0], literal[0], `quote style kept: ${input.code}`);
  return input.code;
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
    code: "const cp = require('child_process'); cp.execSync(`tgrep search --index-path '/repo/.tgrep' --hidden -n foo src`);",
  });

  // cp bound via import * as / default import forms.
  await jsCase("import * as cp from 'child_process'; cp.execSync(`grep -rn foo src`);", {
    action: "rewrite",
    code: "import * as cp from 'child_process'; cp.execSync(`tgrep search --index-path '/repo/.tgrep' --hidden -n foo src`);",
  });
  await jsCase("import cp from 'node:child_process'; cp.exec(`grep -rn foo src`);", {
    action: "rewrite",
    code: "import cp from 'node:child_process'; cp.exec(`tgrep search --index-path '/repo/.tgrep' --hidden -n foo src`);",
  });

  // Chained require().execSync(...) receiver is recognized as child_process directly.
  await jsCase("require('child_process').execSync(`grep -rn foo src`);", {
    action: "rewrite",
    code: "require('child_process').execSync(`tgrep search --index-path '/repo/.tgrep' --hidden -n foo src`);",
  });

  // Single-quoted and escaped literals are decoded, translated, and re-encoded in the same quote style.
  await literalCase(
    String.raw`'grep -rn "downloadbutton" src --include=*.cs | head -20'`,
    "tgrep search --index-path '/repo/.tgrep' --hidden -n -g '*.cs' downloadbutton src | head -20",
  );
  await literalCase(
    String.raw`'grep -n "Minif\\|minif" src/a.cs'`,
    "tgrep search --index-path '/repo/.tgrep' --hidden -n 'Minif|minif' src/a.cs",
  );
  await literalCase(
    String.raw`"grep -rln 'GetAwaiter\\.GetResult\\|\\.Result\\|\\.Wait()' test/ --include='*.cs' | grep -v obj | grep -v bin"`,
    "tgrep search --index-path '/repo/.tgrep' --hidden -l -n -g '*.cs' 'GetAwaiter\\.GetResult|\\.Result|\\.Wait\\(\\)' test/ | grep -v obj | grep -v bin",
  );
  await literalCase(
    "`" + String.raw`rg -l 'inputSchema:\\s*\\{' src/tools/` + "`",
    "tgrep search --index-path '/repo/.tgrep' -l 'inputSchema:\\s*\\{' src/tools/",
  );
  await literalCase(
    String.raw`"grep -rn \"foo bar\" src"`,
    "tgrep search --index-path '/repo/.tgrep' --hidden -n 'foo bar' src",
  );
  await literalCase(
    String.raw`'grep -rn \'foo bar\' src'`,
    "tgrep search --index-path '/repo/.tgrep' --hidden -n 'foo bar' src",
  );
  await literalCase(
    String.raw`'grep -rn \x66o\u006f src\u{2f}app'`,
    "tgrep search --index-path '/repo/.tgrep' --hidden -n foo src/app",
  );
  await literalCase(
    String.raw`'grep -rn foo \
src\nls -la'`,
    "tgrep search --index-path '/repo/.tgrep' --hidden -n foo src\nls -la",
  );

  // argv form: the first argument is just the program name, which runs unchanged.
  await jsCase("const cp = require('child_process'); cp.execFileSync('rg',['--files','-g','!**/bin/**']);", {
    action: "allow",
  });
  await jsCase("require('child_process').spawnSync(\"grep\", ['-rn', 'foo', 'src']);", { action: "allow" });

  // Template interpolation: each ${…} is opaque, so a grep that uses it runs unchanged while the
  // rest of the command is still translated.
  await jsCase("execSync(`grep -rn foo ${dir}`);", { action: "allow" });
  await jsCase("execSync(`grep -rn foo src && echo ${name}`);", {
    action: "rewrite",
    code: "execSync(`tgrep search --index-path '/repo/.tgrep' --hidden -n foo src && echo ${name}`);",
  });
  await jsCase("execSync(`echo ${a.map((x) => `${x}}`).join('}')} && grep -rn foo src`);", {
    action: "rewrite",
    code: "execSync(`echo ${a.map((x) => `${x}}`).join('}')} && tgrep search --index-path '/repo/.tgrep' --hidden -n foo src`);",
  });
  await jsCase("execSync(`grep -rn 'a\\${b}' src; echo ${name}`);", {
    action: "rewrite",
    code: "execSync(`tgrep search --index-path '/repo/.tgrep' --hidden -n 'a\\\\$\\\\{b\\\\}' src; echo ${name}`);",
  });

  // Harmless interpolated templates: "grep" is prose, or only stdin filters are involved.
  await jsCase(
    "execSync(`PI_TGREP_SCOPE=session pi -e ${pkgDir} -p \"Use your grep tool to find where DECISIONS_FILE is defined. Reply with just the file path.\"`, {encoding:'utf8'});",
    { action: "allow" },
  );
  await jsCase(
    "execSync(`strings '${dll}' | grep -iA2 -B2 \"FromKeyedServices\\\\|get_Key\\\\|.ctor\" | head -40`);",
    { action: "allow" },
  );
  await jsCase("execSync(`${ilspy} -l \"${dll}\" 2>&1 | grep -i keyed`);", { action: "allow" });

  // A command that can't be tied to an exec call blocks only when some string literal in the code
  // is a grep that bypasses the index.
  await jsCase(
    "const run = (cmd) => { try { return execSync(cmd, {encoding:'utf8'}).trim(); } catch (e) { return ''; } };\n" +
      "console.log(run(`ps aux | grep -E \"node|vitest|git\" | grep -v grep | sort -rk3 | head -20`));",
    { action: "allow" },
  );
  await jsCase(
    "const run = (cmd) => execSync(cmd, {encoding:'utf8'});\n" +
      "console.log(run('grep -n \"alwaysLoad\" src/storage.ts | head -5'));",
    { action: "block", reasonMatch: /bypasses the tgrep index/ },
  );
  await jsCase(
    "const run = (cmd) => execSync(cmd);\nrun(`grep -rn ${term} src && grep -rn foo lib`);",
    { action: "block", reasonMatch: /bypasses the tgrep index/ },
  );

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
