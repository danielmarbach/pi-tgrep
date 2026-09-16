import assert from "node:assert/strict";
import { applyBashPolicy } from "../src/bash-policy.ts";
import { applyToolCallPolicy } from "../src/watched-tools.ts";

const IDX = { indexPath: "/repo/.tgrep" };
const watched = ["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"];

function policyCase(command, mode, expect, context) {
  const result = applyBashPolicy(command, mode, context);
  assert.deepEqual(
    { action: result.action, command: result.command },
    { action: expect.action, command: expect.command },
    `policy(${mode}): ${command}`,
  );
  return result;
}

function runFallbackTests() {
  // BRE-only constructs: default engine cannot express them, original grep runs verbatim
  policyCase("grep -rn 'a\\(b\\)\\+' src/", "translate", { action: "allow" });
  policyCase("grep -e 'a\\(b\\)' -r src/", "translate", { action: "allow" });
  policyCase("grep -rE '(a)\\1' src/", "translate", { action: "allow" });
  policyCase("egrep '(a)\\1' .", "translate", { action: "allow" });
  policyCase("grep -rn 'a\\(b\\)\\+' src/", "block", { action: "block" });

  // ERE literal escapes are valid in the default engine and translate
  policyCase("egrep '\\(x\\)' .", "translate", { action: "rewrite", command: "tgrep '\\(x\\)' ." });
  // fixed strings never trip pattern checks
  policyCase("fgrep -n 'a\\(b\\)' .", "translate", { action: "rewrite", command: "tgrep -F -n 'a\\(b\\)' ." });

  // -P / --perl-regexp translate to tgrep -P (PCRE2), no BRE fallback
  policyCase("grep -rnP '(?<=a)b' src/", "translate", { action: "rewrite", command: "tgrep -n -P '(?<=a)b' src/" });
  policyCase("grep -P '\\(foo\\)' .", "translate", { action: "rewrite", command: "tgrep -P '\\(foo\\)' ." });
  policyCase("grep --perl-regexp -n 'a' .", "translate", { action: "rewrite", command: "tgrep -P -n a ." });

  // ag/ack/pt run untranslated in translate mode, still blocked in block mode
  policyCase("ag -l needle src/", "translate", { action: "allow" });
  policyCase("ack -w needle lib/", "translate", { action: "allow" });
  policyCase("pt -l needle .", "translate", { action: "allow" });
  policyCase("ag -l needle", "block", { action: "block" });
  assert.equal(applyBashPolicy("ag needle .", "warn").action, "warn");

  // rg keeps translating its own patterns; engine errors surface from the tool like untranslated rg
  policyCase("rg '(a)\\1' src/", "translate", { action: "rewrite", command: "tgrep '(a)\\1' src/" });

  // index-path injection must be -e/-f aware: positionals are all paths when the pattern comes from a flag
  const noInjectE = policyCase("grep -e foo -r /abs/path rel", "translate", {
    action: "rewrite",
    command: "tgrep -e foo /abs/path rel",
  }, IDX);
  assert.ok(!noInjectE.command.includes("--index-path"), "-e with absolute path must skip injection");
  policyCase("grep -e foo -r rel1 rel2", "translate", {
    action: "rewrite",
    command: "tgrep --index-path '/repo/.tgrep' -e foo rel1 rel2",
  }, IDX);
  const noInjectRg = policyCase("rg -e foo /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep -e foo /abs rel",
  }, IDX);
  assert.ok(!noInjectRg.command.includes("--index-path"), "rg -e with absolute path must skip injection");
  policyCase("rg -e foo rel1 rel2", "translate", {
    action: "rewrite",
    command: "tgrep --index-path '/repo/.tgrep' -e foo rel1 rel2",
  }, IDX);
  policyCase("rg -e foo rel", "translate", {
    action: "rewrite",
    command: "tgrep --index-path '/repo/.tgrep' -e foo rel",
  }, IDX);
  // pattern from a flag with no positional path means stdin/no-path: never rewritten
  policyCase("grep -e foo", "translate", { action: "allow" });
  policyCase("rg -f pats.txt", "translate", { action: "allow" });
  const noInjectF = policyCase("grep -f pats.txt /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep -f pats.txt /abs rel",
  }, IDX);
  assert.ok(!noInjectF.command.includes("--index-path"), "-f shifts positionals to paths");
  policyCase("grep -f pats.txt rel", "translate", {
    action: "rewrite",
    command: "tgrep --index-path '/repo/.tgrep' -f pats.txt rel",
  }, IDX);
  const noInjectLong = policyCase("grep --regexp foo /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep -e foo /abs rel",
  }, IDX);
  assert.ok(!noInjectLong.command.includes("--index-path"), "--regexp shifts positionals to paths");
  policyCase("grep --regexp=foo rel1 rel2", "translate", {
    action: "rewrite",
    command: "tgrep --index-path '/repo/.tgrep' -e foo rel1 rel2",
  }, IDX);
  const absAlone = policyCase("rg foo /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep foo /abs rel",
  }, IDX);
  assert.ok(!absAlone.command.includes("--index-path"), "any absolute positional must skip injection");

  // namespaced tool routing still matches watched names as suffixes
  let input = { command: "grep -rn foo ." };
  let r = applyToolCallPolicy("mcp__context-mode__bash", input, "translate", watched);
  assert.equal(r.action, "rewrite");
  assert.equal(input.command, "tgrep -n foo .");
  input = { command: "grep -rn foo ." };
  r = applyToolCallPolicy("mcp__other__unrelated", input, "translate", watched);
  assert.equal(r.action, "allow");

  console.log("bash policy fallback tests ok");
}

function runCompoundCommandTests() {
  // ; and && split compounds like | splits pipelines: non-search parts stay verbatim
  policyCase("head -60 x.txt && grep -c foo y.txt", "translate", {
    action: "rewrite",
    command: "head -60 x.txt && tgrep -c foo y.txt",
  });
  const compoundIdx = policyCase("head -60 x.txt && grep -c foo y.txt", "translate", {
    action: "rewrite",
    command: "head -60 x.txt && tgrep --index-path '/repo/.tgrep' -c foo y.txt",
  }, IDX);
  assert.ok(compoundIdx.command.includes("--index-path"), "index injection lands in the search part only");
  policyCase("echo hi; grep foo bar", "translate", { action: "rewrite", command: "echo hi ; tgrep foo bar" });
  policyCase("grep -rn foo src/ && npm test", "translate", { action: "rewrite", command: "tgrep -n foo src/ && npm test" });
  policyCase("grep foo . && cd /tmp", "translate", { action: "rewrite", command: "tgrep foo . && cd /tmp" });
  policyCase("grep foo .;", "translate", { action: "rewrite", command: "tgrep foo . ;" });

  // pure pipelines keep their exact rendering
  policyCase("grep -rn foo src/ | head -5", "translate", { action: "rewrite", command: "tgrep -n foo src/ | head -5" });
  policyCase("echo x | grep foo . 2>&1 | tee out", "translate", {
    action: "rewrite",
    command: "echo x | tgrep foo . 2>&1 | tee out",
  });
  // cd prefix handling composes with compound splitting
  policyCase("cd /tmp && grep -rn foo .", "translate", { action: "rewrite", command: "cd /tmp && tgrep -n foo ." });

  // anything statically opaque or untranslatable in any part still blocks the whole command
  policyCase("echo a && grep -d skip foo .", "translate", { action: "block" });
  policyCase("echo $(grep foo bar)", "translate", { action: "block" });
  policyCase("echo `grep foo bar`", "translate", { action: "block" });
  policyCase("grep foo < in.txt", "translate", { action: "block" });
  policyCase("grep foo bar &", "translate", { action: "block" });
  policyCase("head x && grep foo y", "block", { action: "block" });

  console.log("bash policy compound tests ok");
}

runFallbackTests();
runCompoundCommandTests();
console.log("ALL FALLBACK TESTS PASSED");
