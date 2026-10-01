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
/** Keywords that can precede a command on the same line, as in `then grep …` or `if grep -q …`. */
const KEYWORD_PREFIXES = new Set(["if", "elif", "while", "until", "then", "else", "do", "!", "{"]);

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

/** In BRE, `(){}+?|` are literal unless backslash-escaped; tgrep's engine always treats them as
 * regex operators, so an unescaped one here would silently change meaning once translated. */
function hasUnescapedBreMetachar(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if ("(){}+?|".includes(pattern[i]!)) return true;
  }
  return false;
}

function patternNeedsFallback(pattern: string, engine: GrepEngine): boolean {
  if (engine === "fixed" || engine === "pcre") return false;
  if (engine === "bre") return BRE_ONLY_PATTERN.test(pattern) || hasUnescapedBreMetachar(pattern);
  return BACKREF_PATTERN.test(pattern);
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

/** End index (after the closing quote) of a `$'…'` string starting at `start`, or -1 if unterminated. */
function consumeAnsiCQuote(text: string, start: number): number {
  for (let i = start + 2; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "'") return i + 1;
  }
  return -1;
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
    if (c === "$" && command[i + 1] === "'") {
      const end = consumeAnsiCQuote(command, i);
      if (end === -1) return null;
      current += command.slice(i + 2, end - 1);
      has = true;
      quoted = true;
      expansion = true;
      i = end - 1;
    } else if (c === "'") {
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
      // A backslash-newline is a line continuation and contributes nothing.
      if (next !== "\n") {
        current += next;
        has = true;
        quoted = true;
      }
    } else if (/\s/.test(c)) {
      flush();
    } else if (c === "#" && !has) {
      break;
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

/** Command split on shell separators. */
interface ScannedCommand {
  kind: "parts";
  parts: string[];
  /** separators[i] joins parts[i] and parts[i + 1]; a newline separator also carries any heredoc bodies it ends. */
  separators: string[];
  /** stdinFed[i]: parts[i] reads stdin from a heredoc or here-string, so tgrep can't stand in for it. */
  stdinFed: boolean[];
  /** blocks[i]: why parts[i] can't be translated if it turns out to be a grep (unsupported redirect or backgrounding). */
  blocks: (string | undefined)[];
  /** Heredoc bodies (terminator included); separators carry an opaque marker in their place. */
  heredocs: string[];
}

const HEREDOC_MARKER = /\u0001H(\d+)\u0001/g;

function restoreHeredocs(text: string, heredocs: string[]): string {
  return text.replace(HEREDOC_MARKER, (_, n: string) => heredocs[Number(n)]!);
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

/** Reads the heredoc delimiter word starting at `start`; returns its unquoted value and end index. */
function readHeredocDelimiter(command: string, start: number): { delimiter: string; end: number } | null {
  let i = start;
  while (command[i] === " " || command[i] === "\t") i++;
  let delimiter = "";
  const wordStart = i;
  while (i < command.length && !/[\s;&|<>()]/.test(command[i]!)) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close === -1) return null;
      delimiter += command.slice(i + 1, close);
      i = close + 1;
    } else if (c === "\\") {
      if (i + 1 >= command.length) return null;
      delimiter += command[i + 1];
      i += 2;
    } else {
      delimiter += c;
      i++;
    }
  }
  return i === wordStart ? null : { delimiter, end: i };
}

/** Consumes lines from `from` up to and including the terminator line. */
function consumeHeredocBody(command: string, from: number, heredoc: PendingHeredoc): number {
  let pos = from;
  while (pos < command.length) {
    const eol = command.indexOf("\n", pos);
    const lineEnd = eol === -1 ? command.length : eol;
    let line = command.slice(pos, lineEnd);
    if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
    pos = eol === -1 ? command.length : eol + 1;
    if (line === heredoc.delimiter) break;
  }
  return pos;
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
  const stdinFed: boolean[] = [];
  const blocks: (string | undefined)[] = [];
  const heredocs: string[] = [];
  const pending: PendingHeredoc[] = [];
  let current = "";
  let currentStdinFed = false;
  let currentBlock: string | undefined;
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const endPart = (separator: string) => {
    parts.push(current);
    stdinFed.push(currentStdinFed);
    blocks.push(currentBlock);
    separators.push(separator);
    current = "";
    currentStdinFed = false;
    currentBlock = undefined;
  };
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
    if (c === "$" && command[i + 1] === "'") {
      const end = consumeAnsiCQuote(command, i);
      if (end === -1) return { kind: "block", reason: UNPARSEABLE_QUOTING_REASON };
      current += command.slice(i, end);
      i = end;
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
    if (c === "#" && (current === "" || /\s$/.test(current))) {
      const eol = command.indexOf("\n", i);
      const end = eol === -1 ? command.length : eol;
      current += command.slice(i, end);
      i = end;
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
    if (c === "\n") {
      i++;
      let separator = "\n";
      for (const heredoc of pending.splice(0)) {
        const end = consumeHeredocBody(command, i, heredoc);
        separator += `\u0001H${heredocs.length}\u0001`;
        heredocs.push(command.slice(i, end));
        i = end;
      }
      endPart(separator);
      continue;
    }
    if (c === ";") {
      const separator = command[i + 1] === ";" ? ";;" : ";";
      endPart(separator);
      i += separator.length;
      continue;
    }
    if (c === "&") {
      if (command[i + 1] === "&") {
        endPart("&&");
        i += 2;
        continue;
      }
      // A single & backgrounds the whole && / || / | list before it, none of which can be translated.
      currentBlock ??= BACKGROUND_BLOCK_REASON;
      for (let k = parts.length - 1; k >= 0 && !/^(;;?|\n)/.test(separators[k]!); k--) {
        blocks[k] ??= BACKGROUND_BLOCK_REASON;
      }
      endPart("&");
      i++;
      continue;
    }
    if (c === "<") {
      if (command[i + 1] !== "<") {
        currentBlock ??= STDIN_REDIRECT_BLOCK_REASON;
        current += c;
        i++;
        continue;
      }
      currentStdinFed = true;
      if (command[i + 2] === "<") {
        // Here-string: the word that follows is scanned as an ordinary operand.
        current += "<<<";
        i += 3;
        continue;
      }
      const stripTabs = command[i + 2] === "-";
      const word = readHeredocDelimiter(command, i + (stripTabs ? 3 : 2));
      if (!word) return { kind: "block", reason: UNPARSEABLE_QUOTING_REASON };
      current += command.slice(i, word.end);
      pending.push({ delimiter: word.delimiter, stripTabs });
      i = word.end;
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
      const separator = command[i + 1] === "|" ? "||" : "|";
      endPart(separator);
      i += separator.length;
      continue;
    }
    current += c;
    i++;
  }
  parts.push(current);
  stdinFed.push(currentStdinFed);
  blocks.push(currentBlock);
  return { kind: "parts", parts, separators, stdinFed, blocks, heredocs };
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
    if (c === "$" && segment[i + 1] === "'") {
      const end = consumeAnsiCQuote(segment, i);
      if (end === -1) break;
      i = end - 1;
    } else if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "#" && (i === 0 || /\s/.test(segment[i - 1]!))) {
      // A comment runs to the end of the segment; a > inside it is not a redirect.
      return { cmd: segment.slice(0, i), suffix: segment.slice(i) };
    } else if (c === ">") {
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

/** A quoted assignment prefix (`FOO='a b'`) must stay quoted when re-emitted. */
function renderPrefix(t: Token): string {
  const eq = t.text.indexOf("=");
  if (!t.quoted || t.expansion || eq === -1 || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) return t.text;
  return t.text.slice(0, eq + 1) + emitToken(t.text.slice(eq + 1), false);
}

function stripPrefixes(tokens: Token[]): { prefixes: string[]; rest: Token[]; ok: boolean } {
  const prefixes: string[] = [];
  const rest = [...tokens];
  for (;;) {
    const head = rest[0];
    if (head === undefined) return { prefixes, rest, ok: false };
    if (
      PREFIX_TOKENS.has(head.text) ||
      (!head.quoted && KEYWORD_PREFIXES.has(head.text)) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(head.text)
    ) {
      prefixes.push(renderPrefix(head));
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
  indexPath: string | undefined,
  stdinFed: boolean,
): SegmentResult {
  const { cmd, suffix } = splitRedirect(segment);
  const tokens = tokenizeDetailed(cmd);
  if (!tokens) {
    return FAMILY_PATTERN.test(segment) ? { kind: "block", reason: UNPARSEABLE_QUOTING_REASON } : { kind: "verbatim" };
  }
  const { prefixes, rest, ok } = stripPrefixes(tokens);
  const bin = rest[0]?.text;
  if (!ok || !bin || !isGrepFamilyBinary(bin)) return { kind: "verbatim" };
  if (mode === "block") return { kind: "block", reason: POLICY_BLOCK_REASON };
  // tgrep doesn't read stdin.
  if (stdinFed) return { kind: "verbatim" };
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

/** Working directory as the command runs; null once a `cd` target can't be resolved statically. */
type Cwd = string | null;

/** The directory after `part` if it is a `cd`, undefined if it is any other command. */
function cwdAfterCd(part: string, cwd: Cwd): Cwd | undefined {
  const tokens = tokenizeDetailed(splitRedirect(part).cmd);
  if (!tokens || tokens[0]?.text !== "cd") return undefined;
  const target = tokens[1];
  if (tokens.length !== 2 || !target || target.expansion || /^[-~]/.test(target.text)) return null;
  if (path.isAbsolute(target.text)) return target.text;
  return cwd === null ? null : path.resolve(cwd, target.text);
}

function isGrepFamilyCommand(part: string): boolean {
  const tokens = tokenizeDetailed(splitRedirect(part).cmd);
  if (!tokens) return FAMILY_PATTERN.test(part);
  const { rest, ok } = stripPrefixes(tokens);
  return ok && rest[0] !== undefined && isGrepFamilyBinary(rest[0].text);
}

function leadingSpace(text: string): string {
  return text.slice(0, text.length - text.trimStart().length);
}

function trailingSpace(text: string): string {
  return text.slice(text.trimEnd().length);
}

export async function applyBashPolicy(
  command: string,
  mode: BashPolicyMode,
  context?: PolicyContext,
): Promise<BashPolicyAction> {
  if (mode === "off") return { action: "allow" };
  if (!FAMILY_PATTERN.test(command)) return { action: "allow" };
  if (mode === "warn") return { action: "warn", command };

  const scanned = scanPipeline(command);
  if (scanned.kind === "block") return { action: "block", reason: scanned.reason };

  const indexCache = new Map<string, Promise<string | undefined>>();
  const indexFor = (cwd: string): Promise<string | undefined> => {
    if (context?.indexPath) return Promise.resolve(context.indexPath);
    if (!context?.resolveIndex) return Promise.resolve(undefined);
    let index = indexCache.get(cwd);
    if (!index) {
      index = context.resolveIndex(cwd);
      indexCache.set(cwd, index);
    }
    return index;
  };

  const { parts, separators } = scanned;
  // The index directory belongs to the directory each segment runs in, so `cd` is followed in order.
  let cwd: Cwd = context?.cwd ?? process.cwd();
  const rendered: string[] = [];
  let changed = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // A cd in a pipeline or in the background runs in a subshell and doesn't move this shell.
    const inSubshell = separators[i - 1] === "|" || separators[i] === "|" || separators[i] === "&";
    const afterCd: Cwd | undefined = inSubshell ? undefined : cwdAfterCd(part, cwd);
    if (afterCd !== undefined) {
      cwd = afterCd;
      rendered.push(part);
      continue;
    }
    let result: SegmentResult;
    const deferredBlock = scanned.blocks[i];
    if (deferredBlock !== undefined && isGrepFamilyCommand(part)) {
      result = { kind: "block", reason: deferredBlock };
    } else if (cwd === null && mode !== "block") {
      // The index can't be located without knowing the directory, so run as-is.
      result = { kind: "verbatim" };
    } else {
      const indexPath = cwd !== null && isGrepFamilyCommand(part) ? await indexFor(cwd) : undefined;
      result = policySegment(part, mode, indexPath, scanned.stdinFed[i]!);
    }
    switch (result.kind) {
      case "block": {
        const where = command.includes("\n") ? ` (in: ${part.trim().slice(0, 120)})` : "";
        return { action: "block", reason: `${result.reason}${where}` };
      }
      case "rewrite":
        changed = true;
        rendered.push(leadingSpace(part) + result.text + trailingSpace(part));
        break;
      case "verbatim":
        rendered.push(part);
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled segment result: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  if (!changed) return { action: "allow" };

  // Untouched text, spacing and separators are kept as written; only rewritten commands change.
  let text = rendered[0]!;
  for (let i = 1; i < parts.length; i++) text += separators[i - 1]! + rendered[i]!;
  return { action: "rewrite", command: restoreHeredocs(text.trim(), scanned.heredocs) };
}
