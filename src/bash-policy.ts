import path from "node:path";
import type { BashPolicyMode } from "./config.js";

export interface PolicyContext {
  /** Direct index directory override (tests, or callers that already resolved it). */
  indexPath?: string;
  /** Base working directory for resolving relative `cd` targets (defaults to process.cwd()). */
  cwd?: string;
  /** Resolves the index directory for a working directory; called with the effective cwd (after any leading `cd`). */
  resolveIndex?: (cwd: string) => Promise<string | undefined>;
}

export type BashPolicyAction = 
  | { action: "allow" }
  | { action: "rewrite"; command: string }
  | { action: "block"; reason: string }
  | { action: "warn"; command: string };

export const FAMILY_PATTERN = /\b(grep|egrep|fgrep|rg|ag|ack|pt)\b/;
const FAMILY_TOKEN = /^(grep|egrep|fgrep|rg|ag|ack|pt)$/;
const SCAN_ONLY_FAMILY = /^(ag|ack|pt)$/;
const PREFIX_TOKENS = new Set(["sudo", "env", "command", "exec", "nice", "nohup", "time"]);

/** Binaries recognized by the grep family policy; scoped narrowly to keep matching exhaustive. */
type GrepFamilyBinary = "grep" | "egrep" | "fgrep" | "rg" | "ag" | "ack" | "pt";
/** Binaries scanned but never rewritten (no rg-compatible translation exists). */
type ScanOnlyBinary = "ag" | "ack" | "pt";
/** Binaries that go through `translateGrep` (POSIX grep and its ERE/fixed-string variants). */
type TranslatableGrepBinary = "grep" | "egrep" | "fgrep";

function isGrepFamilyBinary(value: string): value is GrepFamilyBinary {
  return FAMILY_TOKEN.test(value);
}

function isScanOnlyBinary(value: GrepFamilyBinary): value is ScanOnlyBinary {
  return SCAN_ONLY_FAMILY.test(value);
}

export const BLOCK_REASON =
  "Command uses grep/rg in the shell, which bypasses the tgrep index. Use the grep tool instead " +
  "(path, glob, ignoreCase, literal, context, limit), or run `tgrep search --index-path " +
  "<repo>/.tgrep <pattern> <path>` yourself. Piping into grep (`cmd | grep x`) and grep over " +
  "$var/$(…) file lists run unchanged.";

function blockReason(clause: string): string {
  return `${BLOCK_REASON} ${clause}`;
}

const SUBSTITUTION_BLOCK_REASON = blockReason(
  "This greps inside a command substitution ($(…) or backticks), which can't be rewritten in " +
    "place. Run that search as its own command.",
);
const BACKGROUND_BLOCK_REASON = blockReason(
  "Backgrounding with & isn't scanned for safety. Run the grep segment in the foreground, or " +
    "use the grep tool.",
);
const STDIN_REDIRECT_BLOCK_REASON = blockReason(
  "Input redirected via < can't be translated (tgrep doesn't read stdin like grep does). Use " +
    "the grep tool, or pipe into grep instead, which runs unchanged.",
);
const UNPARSEABLE_QUOTING_REASON = blockReason(
  "The command's quoting couldn't be parsed (unbalanced or unterminated quotes). Fix the " +
    "quoting, or use the grep tool.",
);
const POLICY_BLOCK_REASON = blockReason(
  "PI_TGREP_BASH_POLICY=block disables all shell grep translation. Use the grep tool instead.",
);

/** One classification per flag: a flag that consumes a value must be `arg`, so the "recognized
 * flag whose value silently becomes a positional" misparse class is structurally impossible. */
type RgShortSpec = { kind: "flag" } | { kind: "arg" };
type RgLongSpec = { kind: "flag" } | { kind: "arg"; patternSource?: boolean };

const RG_SHORT_SPECS: Record<string, RgShortSpec> = {
  i: { kind: "flag" }, s: { kind: "flag" }, S: { kind: "flag" }, F: { kind: "flag" },
  w: { kind: "flag" }, v: { kind: "flag" }, U: { kind: "flag" }, l: { kind: "flag" },
  c: { kind: "flag" }, o: { kind: "flag" }, q: { kind: "flag" }, a: { kind: "flag" },
  H: { kind: "flag" }, I: { kind: "flag" }, n: { kind: "flag" }, N: { kind: "flag" },
  p: { kind: "flag" }, b: { kind: "flag" }, x: { kind: "flag" }, L: { kind: "flag" },
  "0": { kind: "flag" }, u: { kind: "flag" },
  e: { kind: "arg" }, f: { kind: "arg" }, m: { kind: "arg" }, g: { kind: "arg" },
  t: { kind: "arg" }, T: { kind: "arg" }, A: { kind: "arg" }, B: { kind: "arg" },
  C: { kind: "arg" }, M: { kind: "arg" }, E: { kind: "arg" }, j: { kind: "arg" },
  r: { kind: "arg" },
};

const RG_LONG_SPECS: Record<`--${string}`, RgLongSpec> = {
  "--ignore-case": { kind: "flag" }, "--case-sensitive": { kind: "flag" },
  "--smart-case": { kind: "flag" }, "--fixed-strings": { kind: "flag" },
  "--word-regexp": { kind: "flag" }, "--invert-match": { kind: "flag" },
  "--multiline": { kind: "flag" }, "--multiline-dotall": { kind: "flag" },
  "--files-with-matches": { kind: "flag" }, "--files-without-match": { kind: "flag" },
  "--count": { kind: "flag" }, "--only-matching": { kind: "flag" },
  "--files": { kind: "flag" }, "--quiet": { kind: "flag" },
  "--glob-case-insensitive": { kind: "flag" }, "--type-list": { kind: "flag" },
  "--no-max-filesize": { kind: "flag" }, "--no-encoding": { kind: "flag" },
  "--text": { kind: "flag" }, "--with-filename": { kind: "flag" },
  "--no-filename": { kind: "flag" }, "--line-number": { kind: "flag" },
  "--no-line-number": { kind: "flag" }, "--heading": { kind: "flag" },
  "--no-heading": { kind: "flag" }, "--json": { kind: "flag" }, "--vimgrep": { kind: "flag" },
  "--null": { kind: "flag" }, "--trim": { kind: "flag" }, "--stats": { kind: "flag" },
  "--no-index": { kind: "flag" }, "--hidden": { kind: "flag" }, "--no-ignore": { kind: "flag" },
  "--follow": { kind: "flag" }, "--no-messages": { kind: "flag" }, "--binary": { kind: "flag" },
  "--line-regexp": { kind: "flag" }, "--pcre2": { kind: "flag" },
  "--pcre2-version": { kind: "flag" }, "--no-unicode": { kind: "flag" },
  "--passthru": { kind: "flag" }, "--stop-on-nonmatch": { kind: "flag" },
  "--column": { kind: "flag" }, "--no-column": { kind: "flag" }, "--byte-offset": { kind: "flag" },
  "--max-columns-preview": { kind: "flag" }, "--count-matches": { kind: "flag" },
  "--include-zero": { kind: "flag" }, "--pretty": { kind: "flag" },
  "--no-context-separator": { kind: "flag" }, "--sort-files": { kind: "flag" },
  "--one-file-system": { kind: "flag" },
  "--ignore-file-case-insensitive": { kind: "flag" }, "--no-ignore-dot": { kind: "flag" },
  "--no-ignore-exclude": { kind: "flag" }, "--no-ignore-files": { kind: "flag" },
  "--no-ignore-global": { kind: "flag" }, "--no-ignore-messages": { kind: "flag" },
  "--no-ignore-parent": { kind: "flag" }, "--no-ignore-vcs": { kind: "flag" },
  "--no-require-git": { kind: "flag" }, "--mmap": { kind: "flag" }, "--no-mmap": { kind: "flag" },
  "--line-buffered": { kind: "flag" }, "--block-buffered": { kind: "flag" },
  "--no-config": { kind: "flag" }, "--crlf": { kind: "flag" }, "--no-crlf": { kind: "flag" },
  "--debug": { kind: "flag" }, "--trace": { kind: "flag" },
  "--help": { kind: "flag" }, "--version": { kind: "flag" },
  "--regexp": { kind: "arg", patternSource: true },
  "--file": { kind: "arg", patternSource: true },
  "--max-count": { kind: "arg" }, "--glob": { kind: "arg" }, "--iglob": { kind: "arg" },
  "--type": { kind: "arg" }, "--type-not": { kind: "arg" }, "--type-add": { kind: "arg" },
  "--type-clear": { kind: "arg" }, "--max-filesize": { kind: "arg" },
  "--encoding": { kind: "arg" }, "--after-context": { kind: "arg" },
  "--before-context": { kind: "arg" }, "--context": { kind: "arg" },
  "--color": { kind: "arg" }, "--index-path": { kind: "arg" }, "--engine": { kind: "arg" },
  "--regex-size-limit": { kind: "arg" }, "--dfa-size-limit": { kind: "arg" },
  "--replace": { kind: "arg" }, "--max-columns": { kind: "arg" },
  "--context-separator": { kind: "arg" },
  "--field-match-separator": { kind: "arg" },
  "--field-context-separator": { kind: "arg" }, "--path-separator": { kind: "arg" },
  "--sort": { kind: "arg" }, "--sortr": { kind: "arg" }, "--max-depth": { kind: "arg" },
  "--ignore-file": { kind: "arg" }, "--threads": { kind: "arg" }, "--colors": { kind: "arg" },
};

type GrepShortSpec =
  | { kind: "emit"; to: string; engine?: GrepEngine }
  | { kind: "arg"; to: string }
  | { kind: "drop"; engine?: GrepEngine };

const GREP_SHORT_SPECS: Record<string, GrepShortSpec> = {
  n: { kind: "emit", to: "-n" }, i: { kind: "emit", to: "-i" },
  F: { kind: "emit", to: "-F", engine: "fixed" }, l: { kind: "emit", to: "-l" },
  c: { kind: "emit", to: "-c" }, v: { kind: "emit", to: "-v" },
  q: { kind: "emit", to: "-q" }, o: { kind: "emit", to: "-o" },
  w: { kind: "emit", to: "-w" }, H: { kind: "emit", to: "-H" },
  a: { kind: "emit", to: "-a" }, b: { kind: "emit", to: "-b" },
  x: { kind: "emit", to: "-x" }, Z: { kind: "emit", to: "-0" },
  y: { kind: "emit", to: "-i" }, h: { kind: "emit", to: "-I" },
  P: { kind: "emit", to: "-P", engine: "pcre" },
  A: { kind: "arg", to: "-A" }, B: { kind: "arg", to: "-B" },
  C: { kind: "arg", to: "-C" }, m: { kind: "arg", to: "-m" },
  e: { kind: "arg", to: "-e" }, f: { kind: "arg", to: "-f" },
  L: { kind: "arg", to: "--files-without-match" },
  r: { kind: "drop" }, R: { kind: "drop" }, s: { kind: "drop" },
  T: { kind: "drop" }, I: { kind: "drop" }, V: { kind: "drop" },
  E: { kind: "drop", engine: "ere" }, G: { kind: "drop", engine: "bre" },
};

type GrepLongSpec =
  | { kind: "emit"; to: string; engine?: GrepEngine }
  | { kind: "arg"; to: string; patternSource?: "regexp" | "file" }
  | { kind: "drop"; engine?: GrepEngine }
  | { kind: "glob"; mode: "include" | "exclude" | "exclude-dir" }
  | { kind: "color" }
  | { kind: "block" };

const GREP_LONG_SPECS: Record<`--${string}`, GrepLongSpec> = {
  "--ignore-case": { kind: "emit", to: "-i" },
  "--fixed-strings": { kind: "emit", to: "-F", engine: "fixed" },
  "--line-number": { kind: "emit", to: "-n" },
  "--files-with-matches": { kind: "emit", to: "-l" },
  "--files-without-match": { kind: "emit", to: "--files-without-match" },
  "--count": { kind: "emit", to: "-c" },
  "--invert-match": { kind: "emit", to: "-v" },
  "--quiet": { kind: "emit", to: "-q" },
  "--silent": { kind: "emit", to: "-q" },
  "--only-matching": { kind: "emit", to: "-o" },
  "--word-regexp": { kind: "emit", to: "-w" },
  "--with-filename": { kind: "emit", to: "-H" },
  "--no-filename": { kind: "emit", to: "-I" },
  "--byte-offset": { kind: "emit", to: "-b" },
  "--line-regexp": { kind: "emit", to: "-x" },
  "--text": { kind: "emit", to: "-a" },
  "--perl-regexp": { kind: "emit", to: "-P", engine: "pcre" },
  "--null": { kind: "emit", to: "-0" },
  "--after-context": { kind: "arg", to: "-A" },
  "--before-context": { kind: "arg", to: "-B" },
  "--context": { kind: "arg", to: "-C" },
  "--max-count": { kind: "arg", to: "-m" },
  "--regexp": { kind: "arg", to: "-e", patternSource: "regexp" },
  "--file": { kind: "arg", to: "-f", patternSource: "file" },
  "--include": { kind: "glob", mode: "include" },
  "--exclude": { kind: "glob", mode: "exclude" },
  "--exclude-dir": { kind: "glob", mode: "exclude-dir" },
  "--color": { kind: "color" },
  "--recursive": { kind: "drop" },
  "--dereference-recursive": { kind: "drop" },
  "--extended-regexp": { kind: "drop", engine: "ere" },
  "--basic-regexp": { kind: "drop", engine: "bre" },
  "--mmap": { kind: "drop" },
  "--initial-tab": { kind: "drop" },
  "--version": { kind: "drop" },
  "--help": { kind: "drop" },
  "--no-group-separator": { kind: "drop" },
  "--group-separator": { kind: "drop" },
  "--binary-files": { kind: "block" },
  "--devices": { kind: "block" },
  "--directories": { kind: "block" },
  "--label": { kind: "block" },
  "--null-data": { kind: "block" },
  "--unix-byte-offsets": { kind: "block" },
  "--group-directories-first": { kind: "block" },
  "--dereference-command-line": { kind: "block" },
  "--no-dereference-command-line": { kind: "block" },
  "--dereference-command-line-symlink-to-dir": { kind: "block" },
  "--exclude-directories": { kind: "block" },
};
const BRE_ONLY_PATTERN = /\\[(){}+?|1-9]|\\<|\\>/;
const UNSAFE_TOKEN_PATTERN = /[\s\\|&;<>()$`*"'?[\]{}~#]/;
const BACKREF_PATTERN = /\\[1-9]/;

type GrepEngine = "fixed" | "ere" | "pcre" | "bre";

function patternNeedsFallback(pattern: string, engine: GrepEngine): boolean {
  if (engine === "fixed" || engine === "pcre") return false;
  return (engine === "bre" ? BRE_ONLY_PATTERN : BACKREF_PATTERN).test(pattern);
}

interface Token {
  text: string;
  quoted: boolean;
  /** Contains an unquoted `$name`/`$(…)`/`${…}` expansion or a backtick, so it can't be resolved statically. */
  expansion: boolean;
}

const EXPANSION_NEXT = /[A-Za-z_{(0-9@*#?!$-]/;

interface OutToken {
  text: string;
  quote?: boolean;
  /** Unquoted in the source command, so re-emitting it as-is keeps globs, ~ and braces expanding. */
  verbatim?: boolean;
}

function passThrough(t: Token): OutToken {
  return t.quoted ? { text: t.text } : { text: t.text, verbatim: true };
}

interface Translation {
  tokens: OutToken[];
  positionals: string[];
  patternFlag: boolean;
  patterns: string[];
  engine: GrepEngine;
}

function tokenizeDetailed(command: string): Token[] | null {
  const tokens: Token[] = [];
  let current = "";
  let has = false;
  let quoted = false;
  let expansion = false;
  let inSingle = false;
  let inDouble = false;
  const flush = () => {
    if (has || current) {
      tokens.push({ text: current, quoted, expansion });
      current = "";
      has = false;
      quoted = false;
      expansion = false;
    }
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      else {
        current += c;
        quoted = true;
      }
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\") {
        const next = command[++i];
        if (next === undefined) return null;
        // Inside double quotes a backslash only escapes $, `, ", \ and newline; otherwise it is literal.
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          current += next;
          quoted = true;
        } else if (next !== "\n") {
          current += "\\" + next;
          quoted = true;
        }
      } else {
        if ((c === "$" && EXPANSION_NEXT.test(command[i + 1] ?? "")) || c === "`") expansion = true;
        current += c;
        quoted = true;
      }
      continue;
    }
    if (c === "'") {
      inSingle = true;
      has = true;
      quoted = true;
    } else if (c === '"') {
      inDouble = true;
      has = true;
      quoted = true;
    } else if (c === "\\") {
      const next = command[++i];
      if (next === undefined) return null;
      current += next;
      has = true;
      quoted = true;
    } else if (/\s/.test(c)) {
      flush();
    } else {
      if ((c === "$" && EXPANSION_NEXT.test(command[i + 1] ?? "")) || c === "`") expansion = true;
      current += c;
      has = true;
    }
  }
  if (inSingle || inDouble) return null;
  flush();
  return tokens;
}

/** Command split on shell separators; separators[i] joins parts[i] and parts[i + 1]. */
interface ScannedCommand {
  kind: "parts";
  parts: string[];
  separators: string[];
}

type ScanResult = ScannedCommand | { kind: "block"; reason: string };

/** Consumes a `$( … )` substitution starting at the index of its opening `(`, honoring nested
 * parens/quotes so separators inside it don't split the pipeline. */
function consumeParenSubstitution(command: string, openParen: number): { end: number; body: string } | null {
  let i = openParen + 1;
  const bodyStart = i;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  while (i < command.length) {
    const c = command[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      i++;
      if (depth === 0) return { end: i, body: command.slice(bodyStart, i - 1) };
      continue;
    }
    i++;
  }
  return null;
}

/** Consumes a backtick substitution starting at the index of the opening backtick. */
function consumeBacktickSubstitution(command: string, backtick: number): { end: number; body: string } | null {
  let i = backtick + 1;
  const bodyStart = i;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return { end: i + 1, body: command.slice(bodyStart, i) };
    i++;
  }
  return null;
}

function scanPipeline(command: string): ScanResult {
  const parts: string[] = [];
  const separators: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (inSingle) {
      current += c;
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        const next = command[i + 1];
        if (next === undefined) return { kind: "block", reason: UNPARSEABLE_QUOTING_REASON };
        current += c + next;
        i += 2;
        continue;
      }
      current += c;
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      current += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      current += c;
      i++;
      continue;
    }
    if (c === "\\") {
      const next = command[i + 1];
      if (next === undefined) return { kind: "block", reason: UNPARSEABLE_QUOTING_REASON };
      current += c + next;
      i += 2;
      continue;
    }
    if (c === "`") {
      const sub = consumeBacktickSubstitution(command, i);
      if (!sub) return { kind: "block", reason: UNPARSEABLE_QUOTING_REASON };
      if (FAMILY_PATTERN.test(sub.body)) return { kind: "block", reason: SUBSTITUTION_BLOCK_REASON };
      current += command.slice(i, sub.end);
      i = sub.end;
      continue;
    }
    if (c === ";") {
      parts.push(current);
      separators.push(";");
      current = "";
      i++;
      continue;
    }
    if (c === "&") {
      // A single & is the background operator; only && separates commands.
      if (command[i + 1] !== "&") return { kind: "block", reason: BACKGROUND_BLOCK_REASON };
      parts.push(current);
      separators.push("&&");
      current = "";
      i += 2;
      continue;
    }
    if (c === "<") {
      if (command[i + 1] !== "<") return { kind: "block", reason: STDIN_REDIRECT_BLOCK_REASON };
      current += "<<";
      i += 2;
      if (command[i] === "-") {
        current += "-";
        i++;
      }
      while (i < command.length && /[A-Za-z0-9_'"]/.test(command[i]!)) {
        current += command[i]!;
        i++;
      }
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const sub = consumeParenSubstitution(command, i + 1);
      if (!sub) return { kind: "block", reason: UNPARSEABLE_QUOTING_REASON };
      if (FAMILY_PATTERN.test(sub.body)) return { kind: "block", reason: SUBSTITUTION_BLOCK_REASON };
      current += command.slice(i, sub.end);
      i = sub.end;
      continue;
    }
    if (c === ">") {
      current += c;
      i++;
      if (command[i] === ">") {
        current += ">";
        i++;
      }
      if (command[i] === "&") {
        current += "&";
        i++;
        while (i < command.length && /[A-Za-z0-9]/.test(command[i]!)) {
          current += command[i]!;
          i++;
        }
      }
      continue;
    }
    if (c === "|") {
      if (command[i + 1] === "|") {
        parts.push(current);
        separators.push("||");
        current = "";
        i += 2;
        continue;
      }
      parts.push(current);
      separators.push("|");
      current = "";
      i++;
      continue;
    }
    current += c;
    i++;
  }
  parts.push(current);
  return { kind: "parts", parts, separators };
}

function splitRedirect(segment: string): { cmd: string; suffix: string } {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\") i++;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === ">") {
      let start = i;
      if (i > 0 && /[0-9]/.test(segment[i - 1]!)) {
        let j = i - 1;
        while (j > 0 && /[0-9]/.test(segment[j - 1]!)) j--;
        if (j === 0 || /\s/.test(segment[j - 1]!)) start = j;
      }
      return { cmd: segment.slice(0, start), suffix: segment.slice(start) };
    }
  }
  return { cmd: segment, suffix: "" };
}

function stripPrefixes(tokens: Token[]): { prefixes: string[]; rest: Token[]; ok: boolean } {
  const prefixes: string[] = [];
  const rest = [...tokens];
  for (;;) {
    const head = rest[0];
    if (head === undefined) return { prefixes, rest, ok: false };
    if (PREFIX_TOKENS.has(head.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head.text)) {
      prefixes.push(head.text);
      rest.shift();
      continue;
    }
    if (head.text.startsWith("-")) return { prefixes, rest, ok: false };
    return { prefixes, rest, ok: true };
  }
}

function expandShortFlags(
  flagText: string,
  flagQuoted: boolean,
  keep: (ch: string) => string | null,
  argFor: (ch: string) => string | null,
  tokens: Token[],
  i: number,
): { emitted: OutToken[]; consumed: number } | { error: string } {
  const chars = flagText;
  const emitted: OutToken[] = [];
  let index = i;
  for (let pos = 0; pos < chars.length; pos++) {
    const ch = chars[pos]!;
    if (argFor(ch)) {
      const mapped = argFor(ch)!;
      const rest = chars.slice(pos + 1);
      if (rest) {
        emitted.push({ text: mapped }, flagQuoted ? { text: rest } : { text: rest, verbatim: true });
        return { emitted, consumed: 0 };
      }
      const value = tokens[++index];
      if (value === undefined) return { error: `-${ch} requires a value` };
      emitted.push({ text: mapped }, passThrough(value));
      return { emitted, consumed: index - i };
    }
    const mapped = keep(ch);
    if (mapped === null) return { error: `-${ch} is not recognized` };
    if (mapped) emitted.push({ text: mapped });
  }
  return { emitted, consumed: 0 };
}

function translateRg(tokens: Token[]): Translation | { error: string } {
  const out: OutToken[] = [];
  const positionals: string[] = [];
  let patternFlag = false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.text === "--") {
      for (const rest of tokens.slice(i + 1)) {
        out.push(passThrough(rest));
        positionals.push(rest.text);
      }
      return { tokens: out, positionals, patternFlag, patterns: [], engine: "ere" };
    }
    if (t.text.startsWith("--")) {
      const eq = t.text.indexOf("=");
      const name = (eq === -1 ? t.text : t.text.slice(0, eq)) as `--${string}`;
      const spec = RG_LONG_SPECS[name];
      if (!spec) return { error: `${name} is not recognized` };
      if (spec.kind === "arg" && spec.patternSource) patternFlag = true;
      out.push(passThrough(t));
      if (eq === -1 && spec.kind === "arg") {
        const value = tokens[++i];
        if (value === undefined) return { error: `${name} requires a value` };
        out.push(passThrough(value));
      }
    } else if (t.text.startsWith("-") && t.text.length > 1) {
      const result = expandShortFlags(
        t.text.slice(1),
        t.quoted,
        (ch) => (RG_SHORT_SPECS[ch]?.kind === "flag" ? `-${ch}` : null),
        (ch) => (RG_SHORT_SPECS[ch]?.kind === "arg" ? `-${ch}` : null),
        tokens,
        i,
      );
      if ("error" in result) return result;
      out.push(...result.emitted);
      i += result.consumed;
      if (result.emitted.some((e) => e.text === "-e") || result.emitted.some((e) => e.text === "-f")) {
        patternFlag = true;
      }
    } else {
      out.push(passThrough(t));
      positionals.push(t.text);
    }
    i++;
  }
  return { tokens: out, positionals, patternFlag, patterns: [], engine: "ere" };
}

function translateGrep(bin: TranslatableGrepBinary, tokens: Token[]): Translation | { error: string } {
  const out: OutToken[] = [];
  const positionalTokens: Token[] = [];
  const ePatterns: string[] = [];
  let patternFlag = false;
  let engine: GrepEngine = bin === "egrep" ? "ere" : bin === "fgrep" ? "fixed" : "bre";
  if (bin === "fgrep") out.push({ text: "-F" });
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.text === "--") {
      positionalTokens.push(...tokens.slice(i + 1));
      break;
    }
    if (t.text.startsWith("--")) {
      const eq = t.text.indexOf("=");
      const name = (eq === -1 ? t.text : t.text.slice(0, eq)) as `--${string}`;
      const value = eq === -1 ? undefined : t.text.slice(eq + 1);
      const spec = GREP_LONG_SPECS[name];
      if (!spec) return { error: `${name} is not recognized` };
      switch (spec.kind) {
        case "emit":
        case "drop":
          if (spec.engine) engine = spec.engine;
          if (spec.kind === "emit") out.push({ text: spec.to });
          break;
        case "arg": {
          if (spec.patternSource) {
            patternFlag = true;
            if (spec.patternSource === "regexp" && value !== undefined) ePatterns.push(value);
          }
          if (value !== undefined) {
            out.push({ text: spec.to }, t.quoted ? { text: value } : { text: value, verbatim: true });
          } else {
            const next = tokens[++i];
            if (next === undefined) return { error: `${name} requires a value` };
            if (spec.patternSource === "regexp") ePatterns.push(next.text);
            out.push({ text: spec.to }, passThrough(next));
          }
          break;
        }
        case "glob": {
          if (value === undefined) return { error: `${name} requires a value` };
          const negate = spec.mode === "include" ? "" : "!";
          const suffix = spec.mode === "exclude-dir" ? "/**" : "";
          out.push({ text: "-g" }, { text: `${negate}${value}${suffix}`, quote: true });
          break;
        }
        case "color":
          out.push({ text: "--color" }, { text: value ?? "auto" });
          break;
        case "block":
          return { error: `${name} is not supported` };
        default: {
          const exhaustive: never = spec;
          throw new Error(`Unhandled grep long flag spec: ${JSON.stringify(exhaustive)}`);
        }
      }
    } else if (t.text.startsWith("-") && t.text.length > 1) {
      const result = expandShortFlags(
        t.text.slice(1),
        t.quoted,
        (ch) => {
          const spec = GREP_SHORT_SPECS[ch];
          if (!spec) return null;
          if (spec.kind !== "arg" && spec.engine) engine = spec.engine;
          return spec.kind === "emit" ? spec.to : "";
        },
        (ch) => {
          const spec = GREP_SHORT_SPECS[ch];
          return spec?.kind === "arg" ? spec.to : null;
        },
        tokens,
        i,
      );
      if ("error" in result) return result;
      if (result.emitted.length > 0) out.push(...result.emitted);
      i += result.consumed;
      for (let k = 0; k < result.emitted.length; k++) {
        const emitted = result.emitted[k]!;
        if (emitted.text === "-e" || emitted.text === "-f") patternFlag = true;
        if (emitted.text === "-e" && result.emitted[k + 1] !== undefined) {
          ePatterns.push(result.emitted[k + 1]!.text);
        }
      }
    } else {
      positionalTokens.push(t);
    }
    i++;
  }
  const positionals = positionalTokens.map((p) => p.text);
  const patterns = patternFlag ? ePatterns : positionals.length > 0 ? [positionals[0]!] : [];
  for (const p of positionalTokens) out.push(passThrough(p));
  return { tokens: out, positionals, patternFlag, patterns, engine };
}

function emitToken(text: string, forceQuote: boolean): string {
  // An empty token must stay a token; a bare '' disappears when the parts are space-joined.
  if (text === "") return "''";
  if (!forceQuote && !UNSAFE_TOKEN_PATTERN.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function renderOutToken(t: OutToken): string {
  if (t.verbatim) return t.text;
  return emitToken(t.text, t.quote === true);
}

type SegmentResult = { kind: "verbatim" } | { kind: "rewrite"; text: string } | { kind: "block"; reason: string };

function policySegment(
  segment: string,
  mode: BashPolicyMode,
  indexPath?: string,
): SegmentResult {
  const { cmd, suffix } = splitRedirect(segment);
  const tokens = tokenizeDetailed(cmd);
  if (!tokens) return { kind: "block", reason: UNPARSEABLE_QUOTING_REASON };
  const { prefixes, rest, ok } = stripPrefixes(tokens);
  const bin = rest[0]?.text;
  if (!ok || !bin || !isGrepFamilyBinary(bin)) return { kind: "verbatim" };
  if (mode === "block") return { kind: "block", reason: POLICY_BLOCK_REASON };
  // A shell expansion in an operand greps an explicit, dynamic list we can't resolve statically.
  if (rest.some((t) => t.expansion)) return { kind: "verbatim" };
  if (isScanOnlyBinary(bin)) return { kind: "verbatim" };
  const translation = bin === "rg" ? translateRg(rest.slice(1)) : translateGrep(bin, rest.slice(1));
  if ("error" in translation) {
    return {
      kind: "block",
      reason: blockReason(`${translation.error}: this flag has no tgrep translation; use the grep tool instead.`),
    };
  }
  if (bin !== "rg" && translation.patterns.some((p) => patternNeedsFallback(p, translation.engine))) {
    return { kind: "verbatim" };
  }
  const forceScan = bin === "rg" && rest.some((t) => t.text === "--files");
  const minPositionals = translation.patternFlag ? 1 : 2;
  if (translation.positionals.length < minPositionals && !forceScan) return { kind: "verbatim" };
  const rendered = ["tgrep", "search"];
  const hasIndexPath = translation.tokens.some((t) => t.text.startsWith("--index-path"));
  const paths = translation.patternFlag ? translation.positionals : translation.positionals.slice(1);
  const allPathsRelative = paths.every((p) => !p.startsWith("/") && !p.startsWith("~"));
  if (indexPath && !hasIndexPath && allPathsRelative) {
    rendered.push("--index-path", emitToken(indexPath, true));
  }
  rendered.push(...translation.tokens.map((t) => renderOutToken(t)));
  const cmdText = [...prefixes, ...rendered].join(" ");
  return { kind: "rewrite", text: suffix ? `${cmdText} ${suffix.trim()}` : cmdText };
}

function extractCdPrefix(command: string): { prefix: string; rest: string; target: string | null } | "unsafe" | null {
  let pos = 0;
  let prefix = "";
  let segments = 0;
  let lastTarget: string | null = null;
  for (;;) {
    while (pos < command.length && /\s/.test(command[pos]!)) pos++;
    if (!command.startsWith("cd", pos)) {
      return segments > 0 ? { prefix, rest: command.slice(pos), target: lastTarget } : null;
    }
    const after = command[pos + 2];
    if (after === undefined || !/\s/.test(after)) {
      return segments > 0 ? { prefix, rest: command.slice(pos), target: lastTarget } : null;
    }
    let cursor = pos + 2;
    while (cursor < command.length && /\s/.test(command[cursor]!)) cursor++;
    const targetStart = cursor;
    let inSingle = false;
    let inDouble = false;
    while (cursor < command.length) {
      const c = command[cursor]!;
      if (inSingle) {
        if (c === "'") inSingle = false;
        cursor++;
        continue;
      }
      if (inDouble) {
        if (c === "$" || c === "`") return "unsafe";
        if (c === "\\") {
          cursor += 2;
          continue;
        }
        if (c === '"') inDouble = false;
        cursor++;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        cursor++;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        cursor++;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === ";" || c === "&") break;
      if ("$`|<>()".includes(c)) return "unsafe";
      cursor++;
    }
    if (cursor === targetStart || inSingle || inDouble) return "unsafe";
    if (command[targetStart] === "-") return "unsafe";
    const target = command.slice(targetStart, cursor);
    segments++;
    lastTarget = target;
    let j = cursor;
    while (j < command.length && /\s/.test(command[j]!)) j++;
    if (command.startsWith("&&", j)) {
      pos = j + 2;
    } else if (command[j] === ";") {
      pos = j + 1;
    } else {
      return { prefix: command.slice(0, cursor), rest: command.slice(cursor), target: lastTarget };
    }
    while (pos < command.length && /\s/.test(command[pos]!)) pos++;
    prefix = command.slice(0, pos);
    if (segments >= 3) return { prefix, rest: command.slice(pos), target: lastTarget };
  }
}

export async function applyBashPolicy(
  command: string,
  mode: BashPolicyMode,
  context?: PolicyContext,
): Promise<BashPolicyAction> {
  if (mode === "off") return { action: "allow" };
  if (!FAMILY_PATTERN.test(command)) return { action: "allow" };
  if (mode === "warn") return { action: "warn", command };

  const cd = extractCdPrefix(command);
  if (cd === "unsafe") {
    // The cd target can't be resolved statically, so the index dir is unknowable; run as-is.
    if (mode === "translate") return { action: "allow" };
    return { action: "block", reason: POLICY_BLOCK_REASON };
  }
  const cdPrefix = cd?.prefix ?? "";
  const effective = cd ? cd.rest : command;

  // The index directory is resolved for the directory the command actually runs in: the
  // leading `cd` target when present, otherwise the policy base cwd.
  let indexPath = context?.indexPath;
  if (!indexPath && context?.resolveIndex) {
    const base = cd?.target ? path.resolve(context.cwd ?? process.cwd(), cd.target) : (context.cwd ?? process.cwd());
    indexPath = await context.resolveIndex(base);
  }

  const scanned = scanPipeline(effective);
  if (scanned.kind === "block") return { action: "block", reason: scanned.reason };

  const rendered: string[] = [];
  let changed = false;
  for (const part of scanned.parts) {
    const result = policySegment(part, mode, indexPath);
    switch (result.kind) {
      case "block":
        return { action: "block", reason: result.reason };
      case "rewrite":
        changed = true;
        rendered.push(result.text);
        break;
      case "verbatim":
        rendered.push(part.trim());
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled segment result: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  if (!changed) return { action: "allow" };
  let text = "";
  for (let i = 0; i < rendered.length; i++) {
    text += rendered[i]!;
    if (i < scanned.separators.length) text += ` ${scanned.separators[i]!} `;
  }
  return { action: "rewrite", command: (cdPrefix + text).trimEnd() };
}
