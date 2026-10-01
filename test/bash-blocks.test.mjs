import assert from "node:assert/strict";
import { applyBashPolicy } from "../src/bash-policy.ts";

async function policyCase(command, mode, expect, context) {
  const result = await applyBashPolicy(command, mode, context);
  assert.deepEqual(
    { action: result.action, command: result.command },
    { action: expect.action, command: expect.command },
    `policy(${mode}): ${command}`,
  );
  return result;
}

async function runShellExpansionAllowTests() {
  // Operands driven by shell expansions grep an explicit, dynamic list; nothing to translate.
  await policyCase("grep -h TargetFramework $(find . -name '*.csproj')", "translate", { action: "allow" });
  await policyCase("f=$(find core -name 'X.cs'); wc -l \"$f\"", "translate", { action: "allow" });
  await policyCase('grep -n -E \'a|b\' "$f"', "translate", { action: "allow" });
  await policyCase('grep -n foo "$f"', "translate", { action: "allow" });
  await policyCase("grep -n foo $FILES", "translate", { action: "allow" });
  await policyCase('grep -rn "$PAT" src', "translate", { action: "allow" });
  await policyCase("grep -n foo `ls *.cs`", "translate", { action: "allow" });
  // an unresolvable cd target (variable) runs the whole command verbatim, not just the cd
  await policyCase('cd "$DIR" && grep -rn foo src', "translate", { action: "allow" });
  console.log("shell expansion allow tests ok");
}

async function runShellExpansionTranslateTests() {
  await policyCase("x=$(date); grep -rn foo src", "translate", {
    action: "rewrite",
    command: "x=$(date) ; tgrep search -n foo src",
  });
  // $ inside single quotes is a literal, not an expansion
  await policyCase("grep -rn 'literal $x in single quotes' src", "translate", {
    action: "rewrite",
    command: "tgrep search -n 'literal $x in single quotes' src",
  });
  console.log("shell expansion translate tests ok");
}

async function runNestedSearchBlockTests() {
  // A grep inside a substitution can't be translated: the outer command must not silently misrun.
  await policyCase("x=$(grep -rn foo src | head -1)", "translate", { action: "block" });
  await policyCase("echo `grep -rn foo src`", "translate", { action: "block" });
  await policyCase('grep -n foo "$f"', "block", { action: "block" });
  console.log("nested search block tests ok");
}

async function runSpecificReasonTests() {
  // Every block reason must say what triggered it, plus carry the hard-required bypass phrase.
  const substitutionParen = await policyCase("echo $(grep foo bar)", "translate", { action: "block" });
  assert.match(substitutionParen.reason, /command substitution/);
  assert.match(substitutionParen.reason, /bypasses the tgrep index/);

  const substitutionBacktick = await policyCase("echo `grep foo bar`", "translate", { action: "block" });
  assert.match(substitutionBacktick.reason, /command substitution/);
  assert.match(substitutionBacktick.reason, /bypasses the tgrep index/);

  const background = await policyCase("grep foo bar &", "translate", { action: "block" });
  assert.match(background.reason, /[Bb]ackground/);
  assert.match(background.reason, /bypasses the tgrep index/);

  const stdinRedirect = await policyCase("grep foo < in.txt", "translate", { action: "block" });
  assert.match(stdinRedirect.reason, /redirected via </);
  assert.match(stdinRedirect.reason, /bypasses the tgrep index/);

  const badQuoting = await policyCase("grep foo 'unterminated", "translate", { action: "block" });
  assert.match(badQuoting.reason, /quoting couldn't be parsed/);
  assert.match(badQuoting.reason, /bypasses the tgrep index/);

  const unknownLongFlag = await policyCase("grep --nonexistent-flag foo .", "translate", { action: "block" });
  assert.match(unknownLongFlag.reason, /--nonexistent-flag/);
  assert.match(unknownLongFlag.reason, /bypasses the tgrep index/);

  const unsupportedLongFlag = await policyCase("grep --binary-files=text -n foo .", "translate", { action: "block" });
  assert.match(unsupportedLongFlag.reason, /--binary-files is not supported/);
  assert.match(unsupportedLongFlag.reason, /bypasses the tgrep index/);

  const unknownShortFlag = await policyCase("grep -z foo .", "translate", { action: "block" });
  assert.match(unknownShortFlag.reason, /-z is not recognized/);
  assert.match(unknownShortFlag.reason, /bypasses the tgrep index/);

  const blockMode = await policyCase("grep -rn needle .", "block", { action: "block" });
  assert.match(blockMode.reason, /PI_TGREP_BASH_POLICY=block/);
  assert.match(blockMode.reason, /bypasses the tgrep index/);

  const blockModeUnsafeCd = await policyCase('cd "$(pwd)" && grep foo .', "block", { action: "block" });
  assert.match(blockModeUnsafeCd.reason, /PI_TGREP_BASH_POLICY=block/);
  assert.match(blockModeUnsafeCd.reason, /bypasses the tgrep index/);

  console.log("specific reason tests ok");
}

async function runOrSeparatorTests() {
  // '||' is a separator like '&&': each side is judged and translated independently.
  const IDX = { indexPath: "/repo/.tgrep" };
  await policyCase("false || grep -rn foo src/", "translate", {
    action: "rewrite",
    command: "false || tgrep search --index-path '/repo/.tgrep' -n foo src/",
  }, IDX);
  await policyCase("grep -rn foo src/ || echo none", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src/ || echo none",
  }, IDX);
  console.log("|| separator tests ok");
}

async function runHeredocTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // The body is data: `<`, quotes, `|`, `&` and the word grep inside it are not shell syntax.
  await policyCase(
    "cat > a.csproj <<'EOF'\n<Project Sdk=\"x\">\n</Project>\nEOF\ndotnet build 2>&1 | grep -E \"warning\" | sort -u",
    "translate",
    { action: "allow" },
    IDX,
  );
  await policyCase("cat <<EOF\nit's a | b & c; grep -rn foo src\nEOF\necho done", "translate", { action: "allow" }, IDX);
  await policyCase("cat <<-EOF\n\tbody <\n\tEOF\nls", "translate", { action: "allow" }, IDX);
  await policyCase("cat <<'A' <<'B'\none <\nA\ntwo <\nB\nls", "translate", { action: "allow" }, IDX);
  // A real grep on another segment is still translated, with the heredoc body kept byte for byte.
  await policyCase("grep -rn foo src && cat <<'EOF'\n<y> it's\nEOF", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src && cat <<'EOF'\n<y> it's\nEOF",
  }, IDX);
  // A heredoc is the grep's stdin; tgrep search doesn't read stdin, so it runs unchanged.
  await policyCase("grep -rn foo src <<EOF\nx\nEOF", "translate", { action: "allow" }, IDX);
  // Here-strings are stdin data too.
  await policyCase("cat <<< \"<x>\" | wc -l", "translate", { action: "allow" }, IDX);
  // A bare < outside a heredoc is still an input redirect.
  const redirect = await policyCase("cat <<EOF\nx\nEOF\ngrep foo < in.txt", "translate", { action: "block" });
  assert.match(redirect.reason, /redirected via </);
  console.log("heredoc tests ok");
}

await runShellExpansionAllowTests();
await runShellExpansionTranslateTests();
await runNestedSearchBlockTests();
await runSpecificReasonTests();
await runOrSeparatorTests();
await runHeredocTests();
console.log("ALL BLOCK TESTS PASSED");
