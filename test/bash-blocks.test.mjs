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
    command: "x=$(date); tgrep search -n foo src",
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

async function runMultiLineTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // A newline separates commands like ; does, so a grep on its own line is translated.
  await policyCase("echo a\ngrep -rn foo src\necho b", "translate", {
    action: "rewrite",
    command: "echo a\ntgrep search --index-path '/repo/.tgrep' -n foo src\necho b",
  }, IDX);
  // Indentation survives, and so does a pipeline that continues on the next line.
  await policyCase("for f in a b; do\n  grep -rn foo src\ndone", "translate", {
    action: "rewrite",
    command: "for f in a b; do\n  tgrep search --index-path '/repo/.tgrep' -n foo src\ndone",
  }, IDX);
  await policyCase("grep -rn foo src |\n  head -3", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src |\n  head -3",
  }, IDX);
  // An escaped newline is a continuation, not a separator.
  await policyCase("grep -rn \\\n  foo src", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // Comments are not scanned: an apostrophe or grep in one is inert.
  await policyCase("# it's a grep -rn foo src\necho hi", "translate", { action: "allow" }, IDX);
  await policyCase("echo hi # don't grep\ngrep -rn foo src", "translate", {
    action: "rewrite",
    command: "echo hi # don't grep\ntgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // ;; closes a case arm and must not become "; ;".
  await policyCase("case $x in\n  a) echo a ;;\nesac\ngrep -rn foo src", "translate", {
    action: "rewrite",
    command: "case $x in\n  a) echo a ;;\nesac\ntgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // Grep reading a here-string has stdin data; it is not translated.
  await policyCase('grep -n foo src <<< "foo"', "translate", { action: "allow" }, IDX);
  // Redirects and backgrounding only block the grep they apply to, not unrelated lines of a script.
  await policyCase("while read l; do echo $l; done < in.txt\ngrep -rn foo src", "translate", {
    action: "rewrite",
    command: "while read l; do echo $l; done < in.txt\ntgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  await policyCase("server &\ngrep -rn foo src", "translate", {
    action: "rewrite",
    command: "server &\ntgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  await policyCase("sleep 1 && grep foo . &\necho done", "translate", { action: "block" }, IDX);
  await policyCase("cat < in.txt | grep foo", "translate", { action: "allow" }, IDX);
  // A block reason names the offending segment when the command spans lines.
  const multiLineBlock = await policyCase("echo a\ngrep --nonexistent-flag foo .", "translate", { action: "block" });
  assert.match(multiLineBlock.reason, /\(in: grep --nonexistent-flag foo \.\)/);
  console.log("multi-line tests ok");
}

async function runReviewRegressionTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // A > in a trailing comment stays a comment.
  await policyCase("grep -rn foo src # TODO: 2>&1 > notes.txt", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src # TODO: 2>&1 > notes.txt",
  }, IDX);
  await policyCase("grep -rn foo src 2>/dev/null # x > y", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src 2>/dev/null # x > y",
  }, IDX);
  // $'…' with an escaped quote doesn't swallow the rest of the script.
  await policyCase("printf $'it\\'s\\n'\nps aux | grep node", "translate", { action: "allow" }, IDX);
  await policyCase("printf $'it\\'s\\n'\ngrep -rn foo src", "translate", {
    action: "rewrite",
    command: "printf $'it\\'s\\n'\ntgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // A $'…' operand can't be resolved statically, so that grep runs unchanged.
  await policyCase("grep -rn $'a\\tb' src", "translate", { action: "allow" }, IDX);
  // An unparseable segment only blocks when the swallowed text contains a grep.
  await policyCase("grep -rn foo src\necho 'oops", "translate", {
    action: "rewrite",
    command: "tgrep search --index-path '/repo/.tgrep' -n foo src\necho 'oops",
  }, IDX);
  const swallowed = await policyCase("echo 'oops\ngrep -rn foo src", "translate", { action: "block" }, IDX);
  assert.match(swallowed.reason, /quoting couldn't be parsed/);
  // A deferred < or & block needs an actual grep command, not the word grep in an argument.
  await policyCase("sort < grep-results.txt\ngrep -rn foo src", "translate", {
    action: "rewrite",
    command: "sort < grep-results.txt\ntgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  await policyCase("npm run rg-server &\ngrep -rn foo src", "translate", {
    action: "rewrite",
    command: "npm run rg-server &\ntgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // Assignment prefixes keep their quoting; an unquoted ~ still expands.
  await policyCase("FOO='a b' grep -rn foo src", "translate", {
    action: "rewrite",
    command: "FOO='a b' tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  await policyCase("FOO=~/x grep -rn foo src", "translate", {
    action: "rewrite",
    command: "FOO=~/x tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // A cd that feeds a pipe or runs in the background is a subshell and doesn't move this shell.
  const calls = [];
  const resolver = { cwd: "/base", resolveIndex: async (cwd) => (calls.push(cwd), `${cwd}/.tgrep`) };
  await policyCase("cd /x | cat\ncd /y &\ngrep -rn a src", "translate", {
    action: "rewrite",
    command: "cd /x | cat\ncd /y &\ntgrep search --index-path '/base/.tgrep' -n a src",
  }, resolver);
  assert.deepEqual(calls, ["/base"]);
  console.log("review regression tests ok");
}

async function runKeywordPrefixTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // A grep after a shell keyword on the same line is still a grep.
  await policyCase("for f in a b; do grep -rn foo src; done", "translate", {
    action: "rewrite",
    command: "for f in a b; do tgrep search --index-path '/repo/.tgrep' -n foo src; done",
  }, IDX);
  await policyCase("if grep -q foo src/a.ts; then\n  echo found\nfi", "translate", {
    action: "rewrite",
    command: "if tgrep search --index-path '/repo/.tgrep' -q foo src/a.ts; then\n  echo found\nfi",
  }, IDX);
  await policyCase("while grep -q foo src/a.ts; do sleep 1; done", "translate", {
    action: "rewrite",
    command: "while tgrep search --index-path '/repo/.tgrep' -q foo src/a.ts; do sleep 1; done",
  }, IDX);
  await policyCase("if true; then grep -rn a src; else grep -rn b src; fi", "translate", {
    action: "rewrite",
    command:
      "if true; then tgrep search --index-path '/repo/.tgrep' -n a src; " +
      "else tgrep search --index-path '/repo/.tgrep' -n b src; fi",
  }, IDX);
  await policyCase("! grep -rn foo src", "translate", {
    action: "rewrite",
    command: "! tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  await policyCase("{ grep -rn foo src; }", "translate", {
    action: "rewrite",
    command: "{ tgrep search --index-path '/repo/.tgrep' -n foo src; }",
  }, IDX);
  // Unchanged cases stay unchanged: stdin filters, dynamic operands, a quoted word that isn't a keyword.
  await policyCase("if cmd | grep -q foo; then echo y; fi", "translate", { action: "allow" }, IDX);
  await policyCase('do_it=1; then_x=2; "then" grep', "translate", { action: "allow" }, IDX);
  await policyCase('for f in a; do grep -n foo "$f"; done', "translate", { action: "allow" }, IDX);
  // Block mode now sees a grep in a condition too.
  await policyCase("if grep -q foo src/a.ts; then echo y; fi", "block", { action: "block" });
  console.log("keyword prefix tests ok");
}

async function runCdTrackingTests() {
  const calls = [];
  const resolver = {
    cwd: "/base",
    resolveIndex: async (cwd) => {
      calls.push(cwd);
      return `${cwd}/.tgrep`;
    },
  };
  // Each grep resolves the index for the directory it actually runs in, wherever the cd is.
  const r = await policyCase("grep -rn a src\ncd /one\ngrep -rn b src\ncd ../two\ngrep -rn c src", "translate", {
    action: "rewrite",
    command:
      "tgrep search --index-path '/base/.tgrep' -n a src\ncd /one\n" +
      "tgrep search --index-path '/one/.tgrep' -n b src\ncd ../two\n" +
      "tgrep search --index-path '/two/.tgrep' -n c src",
  }, resolver);
  assert.equal(r.action, "rewrite");
  assert.deepEqual(calls, ["/base", "/one", "/two"]);
  // After a cd whose target is dynamic, later greps run verbatim (the index is unknowable) until an absolute cd.
  await policyCase('cd "$D"\ngrep -rn a src', "translate", { action: "allow" }, resolver);
  await policyCase('cd "$D"\ncd /abs\ngrep -rn a src', "translate", {
    action: "rewrite",
    command: 'cd "$D"\ncd /abs\ntgrep search --index-path \'/abs/.tgrep\' -n a src',
  }, resolver);
  await policyCase('cd "$D"\ngrep -rn a src', "block", { action: "block" }, resolver);
  // ~ and bare cd can't be resolved statically either.
  await policyCase("cd ~/proj && grep -rn a src", "translate", { action: "allow" }, resolver);
  console.log("cd tracking tests ok");
}

await runShellExpansionAllowTests();
await runShellExpansionTranslateTests();
await runNestedSearchBlockTests();
await runSpecificReasonTests();
await runOrSeparatorTests();
await runHeredocTests();
await runMultiLineTests();
await runCdTrackingTests();
await runReviewRegressionTests();
await runKeywordPrefixTests();
console.log("ALL BLOCK TESTS PASSED");
