import assert from "node:assert/strict";
import { applyBashPolicy } from "../src/bash-policy.ts";
import { applyToolCallPolicy } from "../src/watched-tools.ts";

const IDX = { indexPath: "/repo/.tgrep" };
const watched = ["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"];

async function policyCase(command, mode, expect, context) {
  const result = await applyBashPolicy(command, mode, context);
  assert.deepEqual(
    { action: result.action, command: result.command },
    { action: expect.action, command: expect.command },
    `policy(${mode}): ${command}`,
  );
  return result;
}

async function runFallbackTests() {
  // BRE-only constructs: default engine cannot express them, original grep runs verbatim
  await policyCase("grep -rn 'a\\(b\\)\\+' src/", "translate", { action: "allow" });
  await policyCase("grep -e 'a\\(b\\)' -r src/", "translate", { action: "allow" });
  await policyCase("grep -rE '(a)\\1' src/", "translate", { action: "allow" });
  await policyCase("egrep '(a)\\1' .", "translate", { action: "allow" });
  await policyCase("grep -rn 'a\\(b\\)\\+' src/", "block", { action: "block" });

  // ERE literal escapes are valid in the default engine and translate
  await policyCase("egrep '\\(x\\)' .", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' '\\(x\\)' .",
  }, IDX);
  // fixed strings never trip pattern checks
  await policyCase("fgrep -n 'a\\(b\\)' .", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -F -n 'a\\(b\\)' .",
  }, IDX);

  // -P / --perl-regexp translate to tgrep search -P (PCRE2), no BRE fallback
  await policyCase("grep -rnP '(?<=a)b' src/", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n -P '(?<=a)b' src/",
  }, IDX);
  await policyCase("grep -P '\\(foo\\)' .", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -P '\\(foo\\)' .",
  }, IDX);
  await policyCase("grep --perl-regexp -n 'a' .", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -P -n a .",
  }, IDX);

  // ag/ack/pt run untranslated in translate mode, still blocked in block mode
  await policyCase("ag -l needle src/", "translate", { action: "allow" });
  await policyCase("ack -w needle lib/", "translate", { action: "allow" });
  await policyCase("pt -l needle .", "translate", { action: "allow" });
  await policyCase("ag -l needle", "block", { action: "block" });
  assert.equal((await applyBashPolicy("ag needle .", "warn")).action, "warn");

  // rg keeps translating its own patterns; engine errors surface from the tool like untranslated rg
  await policyCase("rg '(a)\\1' src/", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' '(a)\\1' src/",
  }, IDX);

  // without an index directory to point at, a translatable search runs the original grep verbatim (and warns)
  const noIndex = await applyBashPolicy("grep -rn foo src/", "translate");
  assert.equal(noIndex.action, "allow");
  assert.equal(noIndex.warned, true, "no-index fallback must warn");
  const noIndexCompound = await applyBashPolicy("head -60 x.txt && grep -c foo y.txt", "translate");
  assert.equal(noIndexCompound.action, "allow");
  assert.equal(noIndexCompound.warned, true, "no-index compound fallback must warn");

  // index-path injection must be -e/-f aware: positionals are all paths when the pattern comes from a flag
  const noInjectE = await policyCase("grep -e foo -r /abs/path rel", "translate", {
    action: "rewrite",
    command: "tgrep search -e foo /abs/path rel",
  }, IDX);
  assert.ok(!noInjectE.command.includes("--index-path"), "-e with absolute path must skip injection");
  await policyCase("grep -e foo -r rel1 rel2", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -e foo rel1 rel2",
  }, IDX);
  const noInjectRg = await policyCase("rg -e foo /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep search -e foo /abs rel",
  }, IDX);
  assert.ok(!noInjectRg.command.includes("--index-path"), "rg -e with absolute path must skip injection");
  await policyCase("rg -e foo rel1 rel2", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -e foo rel1 rel2",
  }, IDX);
  await policyCase("rg -e foo rel", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -e foo rel",
  }, IDX);
  // pattern from a flag with no positional path means stdin/no-path: never rewritten
  await policyCase("grep -e foo", "translate", { action: "allow" });
  await policyCase("rg -f pats.txt", "translate", { action: "allow" });
  const noInjectF = await policyCase("grep -f pats.txt /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep search -f pats.txt /abs rel",
  }, IDX);
  assert.ok(!noInjectF.command.includes("--index-path"), "-f shifts positionals to paths");
  await policyCase("grep -f pats.txt rel", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -f pats.txt rel",
  }, IDX);
  const noInjectLong = await policyCase("grep --regexp foo /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep search -e foo /abs rel",
  }, IDX);
  assert.ok(!noInjectLong.command.includes("--index-path"), "--regexp shifts positionals to paths");
  await policyCase("grep --regexp=foo rel1 rel2", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -e foo rel1 rel2",
  }, IDX);
  const absAlone = await policyCase("rg foo /abs rel", "translate", {
    action: "rewrite",
    command: "tgrep search foo /abs rel",
  }, IDX);
  assert.ok(!absAlone.command.includes("--index-path"), "any absolute positional must skip injection");

  // cd-aware index resolution: the resolver sees the effective cwd (leading cd target), not the session cwd
  const resolvedCalls = [];
  const resolver = {
    cwd: "/session",
    resolveIndex: async (cwd) => {
      resolvedCalls.push(cwd);
      return cwd === "/repo" ? "/repo/.tgrep" : undefined;
    },
  };
  const cdResolution = await applyBashPolicy("cd /repo && grep -rn foo src/", "translate", resolver);
  assert.equal(cdResolution.action, "rewrite");
  assert.equal(cdResolution.command, "cd /repo && tgrep search --index-path '/repo/.tgrep' -n foo src/");
  assert.deepEqual(resolvedCalls, ["/repo"], "relative cd targets resolve against the base cwd");
  const relCd = await applyBashPolicy("cd ../repo && grep foo .", "translate", {
    cwd: "/base/x",
    resolveIndex: async (cwd) => (cwd === "/base/repo" ? "/base/repo/.tgrep" : undefined),
  });
  assert.equal(relCd.action, "rewrite");
  assert.equal(relCd.command, "cd ../repo && tgrep search --index-path '/base/repo/.tgrep' foo .");
  const noRepo = await applyBashPolicy("grep foo .", "translate", {
    cwd: "/outside",
    resolveIndex: async () => undefined,
  });
  assert.equal(noRepo.action, "allow");
  assert.equal(noRepo.warned, true, "unresolvable index keeps the original command");

  // namespaced tool routing still matches watched names as suffixes
  let input = { command: "grep -rn foo ." };
  let r = await applyToolCallPolicy("mcp__context-mode__bash", input, "translate", watched, IDX);
  assert.equal(r.action, "rewrite");
  assert.equal(input.command, "tgrep search --index-path '/repo/.tgrep' -n foo .");
  input = { command: "grep -rn foo ." };
  r = await applyToolCallPolicy("mcp__context-mode__bash", input, "translate", watched);
  assert.equal(r.action, "allow");
  assert.equal(r.warned, true, "namespaced bash rewrite without index must fall back verbatim");
  input = { command: "grep -rn foo ." };
  r = await applyToolCallPolicy("mcp__other__unrelated", input, "translate", watched);
  assert.equal(r.action, "allow");

  console.log("bash policy fallback tests ok");
}

async function runCompoundCommandTests() {
  // ; and && split compounds like | splits pipelines: non-search parts stay verbatim
  await policyCase("head -60 x.txt && grep -c foo y.txt", "translate", {
    action: "rewrite",
    command: "head -60 x.txt && tgrep search --index-path '/repo/.tgrep' -c foo y.txt",
  }, IDX);
  await policyCase("echo hi; grep foo bar", "translate", {
    action: "rewrite",
    command: "echo hi ; tgrep search --index-path '/repo/.tgrep' foo bar",
  }, IDX);
  await policyCase("grep -rn foo src/ && npm test", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src/ && npm test",
  }, IDX);
  await policyCase("grep foo . && cd /tmp", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' foo . && cd /tmp",
  }, IDX);
  await policyCase("grep foo .;", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' foo . ;",
  }, IDX);

  // pure pipelines keep their exact rendering
  await policyCase("grep -rn foo src/ | head -5", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src/ | head -5",
  }, IDX);
  await policyCase("echo x | grep foo . 2>&1 | tee out", "translate", {
    action: "rewrite",
    command: "echo x | tgrep search --index-path '/repo/.tgrep' foo . 2>&1 | tee out",
  }, IDX);
  // cd prefix handling composes with compound splitting
  await policyCase("cd /tmp && grep -rn foo .", "translate", {
    action: "rewrite",
    command: "cd /tmp && tgrep search --index-path '/repo/.tgrep' -n foo .",
  }, IDX);

  // anything statically opaque or untranslatable in any part still blocks the whole command
  await policyCase("echo a && grep -d skip foo .", "translate", { action: "block" });
  await policyCase("echo $(grep foo bar)", "translate", { action: "block" });
  await policyCase("echo `grep foo bar`", "translate", { action: "block" });
  await policyCase("grep foo < in.txt", "translate", { action: "block" });
  await policyCase("grep foo bar &", "translate", { action: "block" });
  await policyCase("head x && grep foo y", "block", { action: "block" });

  console.log("bash policy compound tests ok");
}

await runFallbackTests();
await runCompoundCommandTests();
console.log("ALL FALLBACK TESTS PASSED");
