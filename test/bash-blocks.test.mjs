import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    command: "tgrep search -n 'literal \\$x in single quotes' src",
  });
  console.log("shell expansion translate tests ok");
}

async function runSubstitutionPassThroughTests() {
  // Stdin-fed greps and non-grep primary binaries inside a substitution run unchanged.
  const unchanged = [
    "X=$(git ls-files | grep -v obj/)",
    "X=$(cat package.json | grep name)",
    "for f in $(ls | grep ts); do echo $f; done",
    "files=$(git ls-files '*.ts' | grep -vE '(^|/)(bin|obj)/'); echo \"$files\"",
    "rg -n '[x]' $(git ls-files '*.ts' | grep -v test) || true",
    "X=$(which rg)",
    "X=$(command -v rg)",
    "X=$(ls /opt/homebrew/bin/rg)",
    "X=`git ls-files | grep -v obj/`",
    "cd $(git rev-parse --show-toplevel | grep -v x) && ls",
  ];
  for (const command of unchanged) {
    await policyCase(command, "translate", { action: "allow" }, { indexPath: "/repo/.tgrep" });
  }
  console.log("substitution pass-through tests ok");
}

async function runSubstitutionRewriteTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // A real tree scan inside a substitution is translated in place; its stdin filters stay.
  await policyCase("for f in $(grep -rl X src | grep -v obj/); do echo $f; done", "translate", {
    action: "rewrite",
    command: "for f in $(tgrep search --index-path '/repo/.tgrep' -l X src | grep -v obj/); do echo $f; done",
  }, IDX);
  await policyCase("x=$(grep -rn foo src | head -1)", "translate", {
    action: "rewrite",
    command: "x=$(tgrep search --index-path '/repo/.tgrep' -n foo src | head -1)",
  }, IDX);
  await policyCase("echo `grep -rn foo src`", "translate", {
    action: "rewrite",
    command: "echo `tgrep search --index-path '/repo/.tgrep' -n foo src`",
  }, IDX);
  await policyCase("echo $(grep -rn foo src) $(rg -l bar lib)", "translate", {
    action: "rewrite",
    command: "echo $(tgrep search --index-path '/repo/.tgrep' -n foo src) $(tgrep search --index-path '/repo/.tgrep' -l bar lib)",
  }, IDX);
  // the outer grep over the substitution stays verbatim while the inner scan is translated
  await policyCase("grep -n foo $(grep -rl bar src)", "translate", {
    action: "rewrite",
    command: "grep -n foo $(tgrep search --index-path '/repo/.tgrep' -l bar src)",
  }, IDX);
  // the substitution runs where the command runs, so a cd before it selects the index
  const resolved = [];
  await policyCase("cd /other && x=$(grep -rn foo src)", "translate", {
    action: "rewrite",
    command: "cd /other && x=$(tgrep search --index-path '/other/.tgrep' -n foo src)",
  }, {
    cwd: "/start",
    resolveIndex: async (cwd) => {
      resolved.push(cwd);
      return `${cwd}/.tgrep`;
    },
  });
  assert.deepEqual(resolved, ["/other"]);
  // a cd inside the substitution runs in a subshell and applies to that body only
  await policyCase("x=$(cd lib && grep -rn foo .); grep -rn bar .", "translate", {
    action: "rewrite",
    command: "x=$(cd lib && tgrep search --index-path '/start/lib/.tgrep' -n foo .); tgrep search --index-path '/start/.tgrep' -n bar .",
  }, {
    cwd: "/start",
    resolveIndex: async (cwd) => `${cwd}/.tgrep`,
  });
  // a scan that can't be translated (BRE back-reference) stays verbatim
  await policyCase("x=$(grep -rn '\\(a\\)\\1' src)", "translate", { action: "allow" }, IDX);
  // an unresolved cd leaves the whole command, substitution included, verbatim
  await policyCase('cd "$DIR" && x=$(grep -rn foo src)', "translate", { action: "allow" }, IDX);
  console.log("substitution rewrite tests ok");
}

async function runDoubleQuotedSubstitutionTests() {
  // Inside double quotes a $(…) or backtick body has its own quoting, so a " in it doesn't end the string.
  await policyCase(
    `find . -name "*.manifest" | while read f; do echo "$f :: $(grep -E '"(Name|TypeName)"' "$f" | head -3 | tr '\\n' ' ')"; done`,
    "translate",
    { action: "allow" },
  );
  await policyCase('for p in A B; do echo "$p: $(grep -h -E "<TargetFramework|<UseWPF" $p/*.csproj | tr -d " ")"; done', "translate", {
    action: "allow",
  });
  await policyCase('echo "count: $(grep -c foo src/a.ts)"', "translate", {
    action: "rewrite",
    command: 'echo "count: $(tgrep search -c foo src/a.ts)"',
  });
  await policyCase('echo "first: `grep -rl foo src | head -1`"', "translate", {
    action: "rewrite",
    command: 'echo "first: `tgrep search -l foo src | head -1`"',
  });
  await policyCase('echo "x $(echo "a|b" | grep -c a)"', "translate", { action: "allow" });
  console.log("double-quoted substitution tests ok");
}

async function runSubstitutionWordTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // git grep is never translated, so a substitution around it must not be re-tokenized into a grep part.
  await policyCase(
    'cd /repo && A=$(git grep -l "class FailedAuditImportIndex" -- src); P=$(git grep -l "class CustomChecksIndex" -- src); echo "$A"; echo "$P"; cat "$A"; cat "$P"',
    "translate",
    { action: "allow" },
    IDX,
  );
  await policyCase("f=$(git grep -l x -- src | head -1)", "translate", { action: "allow" }, IDX);
  await policyCase("f=`git grep -l x -- src`", "translate", { action: "allow" }, IDX);
  await policyCase('f="$(git grep -l "a b" -- src)"', "translate", { action: "allow" }, IDX);
  await policyCase("f=${X:-git grep -l x}", "translate", { action: "allow" }, IDX);
  // an inner tree scan is still rewritten in place with the assignment intact
  await policyCase("x=$(command grep -rl foo src | head -1)", "translate", {
    action: "rewrite",
    command: "x=$(command tgrep search --index-path '/repo/.tgrep' -l foo src | head -1)",
  }, IDX);
  await policyCase("p=$(command grep -oE 'skills/sandbox[^ ]* +[^ ]+' template/Dockerfile | head -1 | awk '{print $2}')", "translate", {
    action: "rewrite",
    command:
      "p=$(command tgrep search --index-path '/repo/.tgrep' -o 'skills/sandbox[^ ]* +[^ ]+' template/Dockerfile | head -1 | awk '{print $2}')",
  }, IDX);
  // an assignment prefix holding a substitution keeps working for the grep that follows it
  await policyCase('FOO="$(echo a b)" grep -rn foo src', "translate", {
    action: "rewrite",
    command: "FOO=$(echo a b) tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  await policyCase("FOO=$(echo a b) grep -rn foo src", "translate", {
    action: "rewrite",
    command: "FOO=$(echo a b) tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  await policyCase("FOO=${X:-a b} grep -rn foo src", "translate", {
    action: "rewrite",
    command: "FOO=${X:-a b} tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // a redirect inside the substitution does not cut the word short
  await policyCase("x=$(git grep -l y 2>/dev/null | head -1) && echo $x", "translate", { action: "allow" }, IDX);
  // an unterminated expansion is unparseable, like unbalanced quotes
  await policyCase("FOO=${X:-a grep -rn foo src", "translate", { action: "block" }, IDX);
  console.log("substitution word tests ok");
}

async function runProcessSubstitutionTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // a grep reading a process substitution reads a pipe, which tgrep can't serve: it runs unchanged
  const unchanged = [
    'cd /tmp/roslynprobe && grep -n "suppressor: count\\|pragma: count\\|pragma" <(dotnet run 2>&1 | grep -v warning) | head -5',
    'diff <(git diff -U0 -- a.cs | grep -E "^[+-]" | grep -v "^+++\\|^---") <(git diff -U0 -- b.cs | grep -E "^[+-]" | grep -v "^+++\\|^---")',
    'gh pr view 7723 --json body --jq .body | grep -in "v12\\|AppContext\\|remov"; grep -rn "rolling" <(gh pr view 7825 --json body --jq .body) | head',
    'grep -c "LearningTransport" <(ilspycmd lib/net10.0/NServiceBus.Core.dll 2>/dev/null) 2>/dev/null || echo "checking differently"',
    "grep -c x <(cmd)",
    "grep -c x <(cmd a b) <(cmd2)",
    "cat > >(grep -v x)",
    "tee >(grep -v x) > out.txt",
  ];
  for (const command of unchanged) {
    await policyCase(command, "translate", { action: "allow" }, IDX);
  }
  // a tree scan inside a process substitution is translated in place
  await policyCase("while read f; do echo $f; done < <(grep -rl foo src)", "translate", {
    action: "rewrite",
    command: "while read f; do echo $f; done < <(tgrep search --index-path '/repo/.tgrep' -l foo src)",
  }, IDX);
  await policyCase("diff <(grep -rn a src) <(grep -rn b src)", "translate", {
    action: "rewrite",
    command:
      "diff <(tgrep search --index-path '/repo/.tgrep' -n a src) <(tgrep search --index-path '/repo/.tgrep' -n b src)",
  }, IDX);
  await policyCase("grep -c x <(grep -rl foo src | head -2)", "translate", {
    action: "rewrite",
    command: "grep -c x <(tgrep search --index-path '/repo/.tgrep' -l foo src | head -2)",
  }, IDX);
  // a plain stdin redirect still blocks a grep; `< <(…)` blocks only when the redirected command is a grep
  await policyCase("grep foo < file.txt", "translate", { action: "block" }, IDX);
  await policyCase("grep foo < <(cmd)", "translate", { action: "block" }, IDX);
  await policyCase("grep foo < file.txt | head -1", "translate", { action: "block" }, IDX);
  await policyCase("cat < <(echo a b)", "translate", { action: "allow" }, IDX);
  // an unterminated process substitution is unparseable
  await policyCase("grep -c x <(cmd", "translate", { action: "block" }, IDX);
  console.log("process substitution tests ok");
}

async function runSubstitutionBlockTests() {
  // Only unsafe in-place rewrites block: nested backgrounding, an unsupported flag, bad quoting, escaped backticks.
  await policyCase("x=$(grep -rn foo src &)", "translate", { action: "block" });
  await policyCase("x=$(grep -d skip foo src)", "translate", { action: "block" });
  await policyCase("x=$(grep -rn 'foo src)", "translate", { action: "block" });
  await policyCase("echo `grep -rn 'a\\.b' src`", "translate", { action: "block" });
  await policyCase("echo $(grep -rn foo src)", "block", { action: "block" });
  await policyCase("x=$(git ls-files | grep -v obj/)", "block", { action: "block" });
  await policyCase('grep -n foo "$f"', "block", { action: "block" });
  console.log("substitution block tests ok");
}

async function runSpecificReasonTests() {
  // Every block reason must say what triggered it, plus carry the hard-required bypass phrase.
  const substitutionBackground = await policyCase("echo $(grep foo bar &)", "translate", { action: "block" });
  assert.match(substitutionBackground.reason, /[Bb]ackground/);
  assert.match(substitutionBackground.reason, /bypasses the tgrep index/);

  const substitutionBacktick = await policyCase("echo `grep foo 'a\\.b'`", "translate", { action: "block" });
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

async function runPipeFedGrepTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  // A grep reading a pipe runs unchanged even with a flag tgrep can't translate.
  await policyCase(
    "cd /repo/src; git ls-files -z '*.cs' | grep -zv \"Tests/\" | xargs -0 sed -i -E 's/foo/bar/'; git status",
    "translate",
    { action: "allow" },
    IDX,
  );
  await policyCase("git ls-files -z | grep -zv Tests/", "translate", { action: "allow" }, IDX);
  await policyCase("git ls-files | grep -U foo", "translate", { action: "allow" }, IDX);
  await policyCase("git ls-files | rg --some-flag x", "translate", { action: "allow" }, IDX);
  // Another segment of the same command is still translated.
  await policyCase("git ls-files -z | grep -zv Tests/; grep -rn foo src", "translate", {
    action: "rewrite",
    command: "git ls-files -z | grep -zv Tests/; tgrep search --index-path '/repo/.tgrep' -n foo src",
  }, IDX);
  // Not pipe-fed: the unsupported flag still blocks.
  const notPiped = await policyCase("grep -z foo src/a.ts", "translate", { action: "block" }, IDX);
  assert.match(notPiped.reason, /-z is not recognized/);
  await policyCase("echo hi && grep -z foo src/a.ts", "translate", { action: "block" }, IDX);
  await policyCase("grep -z foo src/a.ts | head -3", "translate", { action: "block" }, IDX);
  console.log("pipe-fed grep tests ok");
}

async function runImplicitPathTests() {
  const IDX = { indexPath: "/repo/.tgrep" };
  const prefix = "tgrep search --index-path '/repo/.tgrep'";
  // rg without a path searches the working directory; tgrep search does too.
  await policyCase('rg -l "FromAmqpMessage" --type cs', "translate", {
    action: "rewrite",
    command: `${prefix} -l FromAmqpMessage --type cs`,
  }, IDX);
  await policyCase(
    `rg -n "200000|200_000" --glob '!**/bin/**' --glob '!**/obj/**' --glob '!**/node_modules/**'`,
    "translate",
    {
      action: "rewrite",
      command: `${prefix} -n '200000|200_000' --glob '!**/bin/**' --glob '!**/obj/**' --glob '!**/node_modules/**'`,
    },
    IDX,
  );
  await policyCase("rg -n -e foo -e bar", "translate", {
    action: "rewrite",
    command: `${prefix} -n -e foo -e bar`,
  }, IDX);
  // Recursive grep without a path searches `.`; the `.` keeps grep's ./ output prefix.
  await policyCase('grep -rn "encodingsByCode" --include="*.cs"', "translate", {
    action: "rewrite",
    command: `${prefix} -n -g '*.cs' encodingsByCode .`,
  }, IDX);
  await policyCase('grep -rn "ImplementsInterfaceMember" --include="*.cs" -l', "translate", {
    action: "rewrite",
    command: `${prefix} -n -g '*.cs' -l ImplementsInterfaceMember .`,
  }, IDX);
  await policyCase("grep -R foo", "translate", { action: "rewrite", command: `${prefix} foo .` }, IDX);
  await policyCase("egrep --recursive 'a|b'", "translate", {
    action: "rewrite",
    command: `${prefix} 'a|b' .`,
  }, IDX);
  await policyCase("cd /other && rg foo", "translate", {
    action: "rewrite",
    command: "cd /other && tgrep search --index-path '/repo/.tgrep' foo",
  }, IDX);
  // The implicit working-directory path goes through the ignored-path check as `.`.
  const checked = [];
  await policyCase("rg foo", "translate", {
    action: "rewrite",
    command: `${prefix} --no-ignore-parent foo`,
  }, { ...IDX, cwd: "/repo/build", isIgnored: async (cwd, operand) => (checked.push([cwd, operand]), true) });
  assert.deepEqual(checked, [["/repo/build", "."]]);
  // Still unchanged: pipe-fed, heredoc-fed, or a non-recursive grep (which reads stdin).
  for (const command of [
    "git ls-files | rg foo",
    "git ls-files | grep -r foo",
    "git ls-files | grep -rn foo",
    "grep foo",
    "grep -n foo",
    "rg foo <<< bar",
    "grep -r foo <<< bar",
    "rg foo <<EOF\nbar\nEOF",
  ]) {
    await policyCase(command, "translate", { action: "allow" }, IDX);
  }
  // Not pipe-fed with an unsupported flag still blocks.
  await policyCase("grep -rz foo", "translate", { action: "block" }, IDX);
  console.log("implicit path tests ok");
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
  // A cd under a keyword is conditional or repeated, so the directory is unknown afterwards.
  const resolver = { cwd: "/base", resolveIndex: async (cwd) => `${cwd}/.tgrep` };
  await policyCase('for d in a b; do cd "$d"; make; cd ..; done\ngrep -rn foo src', "translate", { action: "allow" }, resolver);
  await policyCase("if true; then cd /x; fi\ngrep -rn foo src", "translate", { action: "allow" }, resolver);
  // A { } group runs in this shell, so its cd is real.
  await policyCase("{ cd /x; grep -rn foo src; }", "translate", {
    action: "rewrite",
    command: "{ cd /x; tgrep search --index-path '/x/.tgrep' -n foo src; }",
  }, resolver);
  // A condition with a flag that has no tgrep translation is blocked like any other grep.
  const unsupported = await policyCase("if grep -qz x f; then echo y; fi", "translate", { action: "block" }, IDX);
  assert.match(unsupported.reason, /-z is not recognized/);
  // A loop that is backgrounded is translated, not blocked.
  await policyCase("for f in a; do grep -rn x src; done &", "translate", {
    action: "rewrite",
    command: "for f in a; do tgrep search --index-path '/repo/.tgrep' -n x src; done &",
  }, IDX);
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
  // bare cd, cd -, and another user's home can't be resolved statically.
  await policyCase("cd && grep -rn a src", "translate", { action: "allow" }, resolver);
  await policyCase("cd - && grep -rn a src", "translate", { action: "allow" }, resolver);
  console.log("cd tracking tests ok");
}

async function runTildeTests() {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(path.join(tmpdir(), "pi-tgrep-home-"));
  process.env.HOME = home;
  try {
    await writeFile(path.join(home, "file.txt"), "foo\n");
    const answersFor = (dir) => ({
      cwd: "/base",
      resolveIndex: async (cwd) => (cwd === dir ? `${cwd}/.tgrep` : undefined),
    });
    // An unquoted leading ~ is followed by cd and the index is resolved for the expanded directory.
    await policyCase("cd ~/proj && grep -rn foo src", "translate", {
      action: "rewrite",
      command: `cd ~/proj && tgrep search --index-path '${home}/proj/.tgrep' -n foo src`,
    }, answersFor(`${home}/proj`));
    await policyCase("cd ~ && grep -rn foo src", "translate", {
      action: "rewrite",
      command: `cd ~ && tgrep search --index-path '${home}/.tgrep' -n foo src`,
    }, answersFor(home));
    await policyCase("cd ~/proj\ngrep -rn foo src", "translate", {
      action: "rewrite",
      command: `cd ~/proj\ntgrep search --index-path '${home}/proj/.tgrep' -n foo src`,
    }, answersFor(`${home}/proj`));
    // ~user, a quoted ~, and a ~ that isn't leading are not expanded statically.
    await policyCase("cd ~someone && grep -rn foo src", "translate", { action: "allow" }, answersFor(`${home}/proj`));
    await policyCase('cd "~/proj" && grep -rn foo src', "translate", { action: "allow" }, answersFor(`${home}/proj`));
    // A single file operand under ~ still prints its name, as grep -r does for the real path.
    await policyCase("grep -rn foo ~/file.txt", "translate", {
      action: "rewrite",
      command: "tgrep search -H -n foo ~/file.txt",
    }, { indexPath: "/repo/.tgrep" });
    await policyCase('grep -rn foo "~/file.txt"', "translate", {
      action: "rewrite",
      command: "tgrep search -n foo '~/file.txt'",
    }, { indexPath: "/repo/.tgrep" });
    // The ignored-path check sees the expanded path.
    const checked = [];
    await policyCase("grep -rn foo ~/file.txt", "translate", {
      action: "rewrite",
      command: "tgrep search --no-ignore-parent -H -n foo ~/file.txt",
    }, {
      indexPath: "/repo/.tgrep",
      isIgnored: async (cwd, operand) => (checked.push(operand), true),
    });
    assert.deepEqual(checked, [`${home}/file.txt`]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
  console.log("tilde tests ok");
}

await runShellExpansionAllowTests();
await runShellExpansionTranslateTests();
await runSubstitutionPassThroughTests();
await runSubstitutionRewriteTests();
await runSubstitutionWordTests();
await runDoubleQuotedSubstitutionTests();
await runProcessSubstitutionTests();
await runSubstitutionBlockTests();
await runSpecificReasonTests();
await runOrSeparatorTests();
await runHeredocTests();
await runPipeFedGrepTests();
await runImplicitPathTests();
await runMultiLineTests();
await runCdTrackingTests();
await runTildeTests();
await runReviewRegressionTests();
await runKeywordPrefixTests();
console.log("ALL BLOCK TESTS PASSED");
