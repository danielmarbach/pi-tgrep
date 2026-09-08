import type { BashPolicyMode } from "./config.js";

export type BashPolicyAction =
  | { action: "allow" }
  | { action: "rewrite"; command: string }
  | { action: "block"; reason: string }
  | { action: "warn"; command: string };

const FAMILY_PATTERN = /\b(grep|egrep|fgrep|rg|ag|ack|pt)\b/;
const FAMILY_TOKEN = /^(grep|egrep|fgrep|rg|ag|ack|pt)$/;
const SCAN_ONLY_FAMILY = /^(ag|ack|pt)$/;
const PREFIX_TOKENS = new Set(["sudo", "env", "command", "exec", "nice", "nohup", "time"]);

const BLOCK_REASON =
  "Command uses grep/rg in the shell, which bypasses the tgrep index. Use the grep tool instead " +
  "(it supports path, glob, ignoreCase, literal, context, limit), or run tgrep directly.";

const RG_SHORT: Set<string> = new Set(
  "isSFwvefUlcoEmqgtTaABCHInNMpbxjL0urp".split(""),
);
const RG_SHORT_ARG = new Set(["e", "f", "m", "g", "t", "T", "A", "B", "C", "M", "E", "j", "r"]);
const RG_LONG: Set<string> = new Set(
  [
    "ignore-case", "case-sensitive", "smart-case", "fixed-strings", "word-regexp", "invert-match",
    "regexp", "file", "multiline", "multiline-dotall", "files-with-matches", "files-without-match",
    "count", "only-matching", "max-count", "files", "quiet", "glob", "iglob", "glob-case-insensitive",
    "type", "type-not", "type-add", "type-clear", "type-list", "max-filesize", "no-max-filesize",
    "encoding", "no-encoding", "text", "after-context", "before-context", "context", "with-filename",
    "no-filename", "line-number", "no-line-number", "heading", "no-heading", "json", "vimgrep",
    "color", "null", "trim", "stats", "no-index", "index-path", "hidden", "no-ignore", "follow",
    "no-messages", "binary", "line-regexp", "pcre2", "engine", "pcre2-version", "no-unicode",
    "regex-size-limit", "dfa-size-limit", "replace", "passthru", "stop-on-nonmatch", "column",
    "no-column", "byte-offset", "max-columns", "max-columns-preview", "count-matches", "include-zero",
    "pretty", "context-separator", "no-context-separator", "field-match-separator",
    "field-context-separator", "path-separator", "sort", "sortr", "sort-files", "max-depth",
    "one-file-system", "ignore-file", "ignore-file-case-insensitive", "no-ignore-dot",
    "no-ignore-exclude", "no-ignore-files", "no-ignore-global", "no-ignore-messages",
    "no-ignore-parent", "no-ignore-vcs", "no-require-git", "threads", "mmap", "no-mmap",
    "line-buffered", "block-buffered", "no-config", "colors", "crlf", "no-crlf", "debug", "trace",
    "help", "version",
  ].map((name) => `--${name}`),
);
const RG_LONG_ARG = new Set(
  [
    "regexp", "file", "max-count", "glob", "iglob", "type", "type-not", "type-add", "type-clear",
    "max-filesize", "encoding", "after-context", "before-context", "context", "color", "index-path",
    "engine", "regex-size-limit", "dfa-size-limit", "replace", "max-columns", "context-separator",
    "field-match-separator", "field-context-separator", "path-separator", "sort", "sortr",
    "max-depth", "ignore-file", "threads", "colors",
  ].map((name) => `--${name}`),
);

const GREP_SHORT_KEEP: Record<string, string> = {
  n: "-n", i: "-i", F: "-F", l: "-l", c: "-c", v: "-v", q: "-q", o: "-o", w: "-w", H: "-H",
  a: "-a", b: "-b", x: "-x", Z: "-0", y: "-i", h: "-I",
};
const GREP_SHORT_DROP = new Set(["r", "R", "E", "s", "T", "I", "V", "G"]);
const GREP_SHORT_ARG: Record<string, string> = { A: "-A", B: "-B", C: "-C", m: "-m", e: "-e", f: "-f", L: "--files-without-match" };
const GREP_LONG_SIMPLE: Record<string, string> = {
  "--ignore-case": "-i", "--fixed-strings": "-F", "--line-number": "-n",
  "--files-with-matches": "-l", "--files-without-match": "--files-without-match", "--count": "-c",
  "--invert-match": "-v", "--quiet": "-q", "--silent": "-q", "--only-matching": "-o",
  "--word-regexp": "-w", "--with-filename": "-H", "--no-filename": "-I", "--byte-offset": "-b",
  "--line-regexp": "-x", "--text": "-a", "--perl-regexp": "-P", "--null": "-0",
};
const GREP_LONG_ARG: Record<string, string> = {
  "--after-context": "-A", "--before-context": "-B", "--context": "-C", "--max-count": "-m",
  "--regexp": "-e", "--file": "-f",
};
const GREP_LONG_DROP = new Set([
  "--recursive", "--dereference-recursive", "--extended-regexp", "--mmap",
  "--initial-tab", "--version", "--help", "--no-group-separator", "--group-separator",
]);
const GREP_LONG_BLOCK = new Set([
  "--basic-regexp", "--binary-files", "--devices", "--directories", "--label", "--null-data",
  "--unix-byte-offsets", "--group-directories-first", "--dereference-command-line",
  "--no-dereference-command-line", "--dereference-command-line-symlink-to-dir", "--exclude-directories",
]);
const BRE_ONLY_PATTERN = /\\[(){}+?|1-9]|\\<|\\>/;
const UNSAFE_TOKEN_PATTERN = /[\s|&;<>()$`*"'?[\]{}~#]/;

interface Token {
  text: string;
  quoted: boolean;
}

interface OutToken {
  text: string;
  quote?: boolean;
}

interface Translation {
  tokens: OutToken[];
  positionalCount: number;
}

function tokenizeDetailed(command: string): Token[] | null {
  const tokens: Token[] = [];
  let current = "";
  let has = false;
  let quoted = false;
  let inSingle = false;
  let inDouble = false;
  const flush = () => {
    if (has || current) {
      tokens.push({ text: current, quoted });
      current = "";
      has = false;
      quoted = false;
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
        current += next;
        quoted = true;
      } else {
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
      current += c;
      has = true;
    }
  }
  if (inSingle || inDouble) return null;
  flush();
  return tokens;
}

function scanPipeline(command: string): string[] | null {
  const segments: string[] = [];
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
        if (next === undefined) return null;
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
      if (next === undefined) return null;
      current += c + next;
      i += 2;
      continue;
    }
    if (c === ";" || c === "`" || c === "&" || c === "<") return null;
    if (c === "$" && command[i + 1] === "(") return null;
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
      if (command[i + 1] === "|") return null;
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    current += c;
    i++;
  }
  segments.push(current);
  return segments;
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
    else if (c === ">") return { cmd: segment.slice(0, i), suffix: segment.slice(i) };
  }
  return { cmd: segment, suffix: "" };
}

function stripPrefixes(tokens: string[]): { prefixes: string[]; rest: string[]; ok: boolean } {
  const prefixes: string[] = [];
  const rest = [...tokens];
  for (;;) {
    const head = rest[0];
    if (head === undefined) return { prefixes, rest, ok: false };
    if (PREFIX_TOKENS.has(head) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      prefixes.push(head);
      rest.shift();
      continue;
    }
    if (head.startsWith("-")) return { prefixes, rest, ok: false };
    return { prefixes, rest, ok: true };
  }
}

function expandShortFlags(
  flagText: string,
  keep: (ch: string) => string | null,
  argFor: (ch: string) => string | null,
  tokens: string[],
  i: number,
): { emitted: string[]; consumed: number } | null {
  const chars = flagText;
  const emitted: string[] = [];
  let index = i;
  for (let pos = 0; pos < chars.length; pos++) {
    const ch = chars[pos]!;
    if (argFor(ch)) {
      const mapped = argFor(ch)!;
      const rest = chars.slice(pos + 1);
      if (rest) {
        emitted.push(mapped, rest);
        return { emitted, consumed: 0 };
      }
      const value = tokens[++index];
      if (value === undefined) return null;
      emitted.push(mapped, value);
      return { emitted, consumed: index - i };
    }
    const mapped = keep(ch);
    if (mapped === null) return null;
    if (mapped) emitted.push(mapped);
  }
  return { emitted, consumed: 0 };
}

function translateRg(tokens: string[]): Translation | null {
  const out: OutToken[] = [];
  let positionalCount = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") {
      for (const rest of tokens.slice(i + 1)) {
        out.push({ text: rest });
        positionalCount++;
      }
      return { tokens: out, positionalCount };
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      if (!RG_LONG.has(name)) return null;
      out.push({ text: t });
      if (eq === -1 && RG_LONG_ARG.has(name)) {
        const value = tokens[++i];
        if (value === undefined) return null;
        out.push({ text: value });
      }
    } else if (t.startsWith("-") && t.length > 1) {
      const result = expandShortFlags(
        t.slice(1),
        (ch) => (RG_SHORT.has(ch) && !RG_SHORT_ARG.has(ch) ? `-${ch}` : null),
        (ch) => (RG_SHORT_ARG.has(ch) ? `-${ch}` : null),
        tokens,
        i,
      );
      if (!result) return null;
      out.push(...result.emitted.map((e) => ({ text: e })));
      i += result.consumed;
    } else {
      out.push({ text: t });
      positionalCount++;
    }
    i++;
  }
  return { tokens: out, positionalCount };
}

function translateGrep(bin: string, tokens: string[]): Translation | null {
  const out: OutToken[] = [];
  const positionals: string[] = [];
  if (bin === "fgrep") out.push({ text: "-F" });
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const value = eq === -1 ? undefined : t.slice(eq + 1);
      if (name === "--include" && value !== undefined) {
        out.push({ text: "-g" }, { text: value, quote: true });
      } else if (name === "--exclude" && value !== undefined) {
        out.push({ text: "-g" }, { text: `!${value}`, quote: true });
      } else if (name === "--exclude-dir" && value !== undefined) {
        out.push({ text: "-g" }, { text: `!${value}/**`, quote: true });
      } else if (name === "--color") {
        out.push({ text: "--color" }, { text: value ?? "auto" });
      } else if (GREP_LONG_SIMPLE[name]) {
        out.push({ text: GREP_LONG_SIMPLE[name]! });
      } else if (GREP_LONG_ARG[name]) {
        if (value !== undefined) out.push({ text: GREP_LONG_ARG[name]! }, { text: value });
        else {
          const next = tokens[++i];
          if (next === undefined) return null;
          out.push({ text: GREP_LONG_ARG[name]! }, { text: next });
        }
      } else if (GREP_LONG_DROP.has(name)) {
        // dropped: recursive-by-default, accepted-for-compatibility, or no-op flags
      } else if (GREP_LONG_BLOCK.has(name)) {
        return null;
      } else {
        return null;
      }
    } else if (t.startsWith("-") && t.length > 1) {
      const result = expandShortFlags(
        t.slice(1),
        (ch) => {
          if (GREP_SHORT_KEEP[ch]) return GREP_SHORT_KEEP[ch]!;
          if (GREP_SHORT_ARG[ch]) return "";
          if (GREP_SHORT_DROP.has(ch)) return "";
          return null;
        },
        (ch) => (GREP_SHORT_ARG[ch] ? GREP_SHORT_ARG[ch]! : null),
        tokens,
        i,
      );
      if (!result) return null;
      if (result.emitted.length > 0) out.push(...result.emitted.map((e) => ({ text: e })));
      i += result.consumed;
    } else {
      positionals.push(t);
    }
    i++;
  }
  if (positionals.length > 0 && BRE_ONLY_PATTERN.test(positionals[0]!)) return null;
  for (const p of positionals) out.push({ text: p });
  return { tokens: out, positionalCount: positionals.length };
}

function emitToken(text: string, forceQuote: boolean): string {
  if (!forceQuote && !UNSAFE_TOKEN_PATTERN.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function policySegment(
  segment: string,
  mode: BashPolicyMode,
): { kind: "verbatim" } | { kind: "rewrite"; text: string } | "block" {
  const { cmd, suffix } = splitRedirect(segment);
  const tokens = tokenizeDetailed(cmd);
  if (!tokens) return "block";
  const { prefixes, rest, ok } = stripPrefixes(tokens.map((t) => t.text));
  const bin = rest[0];
  if (!ok || !bin || !FAMILY_TOKEN.test(bin)) return { kind: "verbatim" };
  if (SCAN_ONLY_FAMILY.test(bin)) return "block";
  if (mode === "block") return "block";
  const translation = bin === "rg" ? translateRg(rest.slice(1)) : translateGrep(bin, rest.slice(1));
  if (!translation) return "block";
  const forceScan = bin === "rg" && rest.includes("--files");
  if (translation.positionalCount <= 1 && !forceScan) return { kind: "verbatim" };
  const rendered = ["tgrep", ...translation.tokens.map((t) => emitToken(t.text, t.quote === true))];
  const cmdText = [...prefixes, ...rendered].join(" ");
  return { kind: "rewrite", text: suffix ? `${cmdText} ${suffix.trim()}` : cmdText };
}

export function applyBashPolicy(command: string, mode: BashPolicyMode): BashPolicyAction {
  if (mode === "off") return { action: "allow" };
  if (!FAMILY_PATTERN.test(command)) return { action: "allow" };
  if (mode === "warn") return { action: "warn", command };

  const segments = scanPipeline(command);
  if (!segments) return { action: "block", reason: BLOCK_REASON };

  const rendered: string[] = [];
  let changed = false;
  for (const segment of segments) {
    const result = policySegment(segment, mode);
    if (result === "block") return { action: "block", reason: BLOCK_REASON };
    if (result.kind === "rewrite") {
      changed = true;
      rendered.push(result.text);
    } else {
      rendered.push(segment.trim());
    }
  }
  if (!changed) return { action: "allow" };
  return { action: "rewrite", command: rendered.join(" | ") };
}
