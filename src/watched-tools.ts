import path from "node:path";
import type { BashPolicyMode } from "./config.ts";
import { applyBashPolicy, BLOCK_REASON, FAMILY_PATTERN, type PolicyContext } from "./bash-policy.ts";

export const DEFAULT_WATCHED_TOOLS = ["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"];

export type ToolPolicyAction =
  | { action: "allow"; warned?: boolean }
  | { action: "block"; reason: string }
  | { action: "rewrite"; code?: string };

export function watchedKey(toolName: string, watchedTools: string[]): string | null {
  for (const watched of watchedTools) {
    if (toolName === watched || toolName.endsWith(`__${watched}`)) return watched;
  }
  return null;
}

const HEREDOC_MARKER = /<<-?\s*(\S+)/;
const PLAIN_CD = /^cd\s+(\S+)\s*$/;

// A plain `cd <target>` line changes the directory for the lines that follow in a shell block.
function dirAfterCd(dir: string | undefined, trimmed: string): string | undefined {
  if (dir === undefined) return undefined;
  const match = PLAIN_CD.exec(trimmed);
  if (!match) return dir;
  const target = match[1]!;
  if (target === "-" || target.startsWith("-") || target.startsWith("~")) return dir;
  if (UNSAFE_CD_TARGET.test(target)) return dir;
  return path.resolve(dir, target);
}

// Characters that make a cd target impossible to resolve statically.
const UNSAFE_CD_TARGET = /[$`'"|&;<>()*?[\]{}#]/;

async function applyToShellCode(
  code: string,
  mode: BashPolicyMode,
  context?: PolicyContext,
): Promise<ToolPolicyAction> {
  const hasHeredoc = HEREDOC_MARKER.test(code);
  const lines = code.split("\n");
  let heredocEnd: string | null = null;
  let changed = false;
  let warned = false;
  let dir = context?.cwd;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (HEREDOC_MARKER.test(line)) {
        const marker = HEREDOC_MARKER.exec(line)?.[1];
        if (marker) heredocEnd = marker.replace(/^['"]|['"]$/g, "");
      }
      continue;
    }
    const result = await applyBashPolicy(line, hasHeredoc ? "block" : mode, { ...context, cwd: dir });
    if (result.action === "block") {
      const hint = hasHeredoc ? " (heredoc bodies are never rewritten)" : "";
      return {
        action: "block",
        reason: `${result.reason} (line ${i + 1}: ${trimmed.slice(0, 120)})${hint}`,
      };
    }
    if (result.action === "rewrite") {
      const indent = line.slice(0, line.length - trimmed.length);
      lines[i] = `${indent}${result.command}`;
      changed = true;
    } else if (result.action === "allow" && result.warned) {
      warned = true;
    }
    if (!heredocEnd) {
      const marker = HEREDOC_MARKER.exec(line)?.[1];
      if (marker) heredocEnd = marker.replace(/^['"]|['"]$/g, "");
    }
    dir = dirAfterCd(dir, trimmed);
  }
  if (!changed) return warned ? { action: "allow", warned: true } : { action: "allow" };
  return { action: "rewrite", code: lines.join("\n") };
}

const JS_EXEC_CALL = /\b(execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*\(/g;

interface JsStringArg {
  quote: string;
  content: string;
  contentStart: number;
  contentEnd: number;
}

function parseJsFirstStringArg(code: string, from: number): JsStringArg | null {
  let i = from;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  const quote = code[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let j = i + 1;
  while (j < code.length) {
    const c = code[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) {
      return { quote, content: code.slice(i + 1, j), contentStart: i + 1, contentEnd: j };
    }
    j++;
  }
  return null;
}

async function applyJsChildProcessGuard(code: string, mode: BashPolicyMode, context?: PolicyContext): Promise<ToolPolicyAction> {
  const calls = [...code.matchAll(JS_EXEC_CALL)];
  let changed = false;
  let warned = false;
  for (let k = calls.length - 1; k >= 0; k--) {
    const call = calls[k]!;
    const fn = call[1]!;
    const parse = parseJsFirstStringArg(code, call.index + call[0].length);
    if (!parse) {
        return {
          action: "block",
          reason: `${BLOCK_REASON} The command passed to ${fn}() could not be extracted statically, and shell grep inside JavaScript bypasses the tgrep index. Use the grep tool instead.`,
        };
      }
      if (!FAMILY_PATTERN.test(parse.content)) continue;
      if (parse.content.includes("\\")) {
        return {
          action: "block",
          reason: `${BLOCK_REASON} The grep command inside ${fn}() contains escape sequences that cannot be rewritten safely in place; shell grep inside JavaScript bypasses the tgrep index.`,
        };
      }
      if (parse.quote === "'") {
        return {
          action: "block",
          reason: `${BLOCK_REASON} The grep command is single-quoted inside JavaScript and cannot be rewritten in place; shell grep inside JavaScript bypasses the tgrep index.`,
        };
      }
      if (parse.quote === "`" && parse.content.includes("${")) {
        return {
          action: "block",
          reason: `${BLOCK_REASON} The grep command uses template interpolation and cannot be rewritten safely; shell grep inside JavaScript bypasses the tgrep index.`,
        };
      }
      const result = await applyBashPolicy(parse.content, mode, context);
      if (result.action === "block") {
        return {
          action: "block",
          reason: `${result.reason} (embedded in JavaScript ${fn}(); shell grep inside JavaScript bypasses the tgrep index)`,
        };
      }
      if (result.action === "rewrite") {
        code = code.slice(0, parse.contentStart) + result.command + code.slice(parse.contentEnd);
        changed = true;
      } else if (result.action === "allow" && result.warned) {
        warned = true;
      }
    }
    return changed ? { action: "rewrite", code } : warned ? { action: "allow", warned: true } : { action: "allow" };
}

export async function applyToolCallPolicy(
  toolName: string,
  input: Record<string, unknown> | undefined,
  mode: BashPolicyMode,
  watchedTools: string[] = DEFAULT_WATCHED_TOOLS,
  context?: PolicyContext,
): Promise<ToolPolicyAction> {
  if (mode === "off") return { action: "allow" };
  const key = watchedKey(toolName, watchedTools);
  if (!key || !input) return { action: "allow" };

  if (key === "ctx_batch_execute") {
    const commands = input.commands;
    if (!Array.isArray(commands)) return { action: "allow" };
    let changed = false;
    let warned = false;
    for (let i = 0; i < commands.length; i++) {
      const entry = commands[i];
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as { command?: unknown; label?: unknown };
      if (typeof rec.command !== "string" || !rec.command) continue;
      if (mode === "warn") {
        if (FAMILY_PATTERN.test(rec.command)) return { action: "allow", warned: true };
        continue;
      }
      const result = await applyBashPolicy(rec.command, mode, context);
      if (result.action === "block") {
        const label = typeof rec.label === "string" && rec.label ? rec.label : `entry ${i + 1}`;
        return { action: "block", reason: `${result.reason} (entry: ${label})` };
      }
      if (result.action === "rewrite") {
        rec.command = result.command;
        changed = true;
      } else if (result.action === "allow" && result.warned) {
        warned = true;
      }
    }
    return changed ? { action: "rewrite" } : warned ? { action: "allow", warned: true } : { action: "allow" };
  }

  if (key === "ctx_execute" || key === "ctx_execute_file") {
    const language = input.language;
    const code = input.code;
    if (typeof code !== "string" || !code) return { action: "allow" };
    if (language !== "shell") {
      if (mode === "warn") return { action: "allow" };
      const guard = await applyJsChildProcessGuard(code, mode, context);
      if (guard.action === "block") return { action: "block", reason: guard.reason };
      if (guard.action === "rewrite" && typeof guard.code === "string") {
        input.code = guard.code;
        return { action: "rewrite" };
      }
      return guard.action === "allow" && guard.warned ? { action: "allow", warned: true } : { action: "allow" };
    }
    if (mode === "warn") {
      return FAMILY_PATTERN.test(code) ? { action: "allow", warned: true } : { action: "allow" };
    }
    const result = await applyToShellCode(code, mode, context);
    if (result.action === "block") return { action: "block", reason: result.reason };
    if (result.action === "rewrite" && typeof result.code === "string") {
      input.code = result.code;
      return { action: "rewrite" };
    }
    return result.action === "allow" && result.warned ? { action: "allow", warned: true } : { action: "allow" };
  }

  const command = input.command;
  if (typeof command !== "string" || !command) return { action: "allow" };
  if (mode === "warn") {
    return FAMILY_PATTERN.test(command) ? { action: "allow", warned: true } : { action: "allow" };
  }
  const result = await applyBashPolicy(command, mode, context);
  if (result.action === "block") return { action: "block", reason: result.reason };
  if (result.action === "rewrite") {
    input.command = result.command;
    return { action: "rewrite" };
  }
  return { action: "allow", warned: result.action === "allow" && result.warned ? true : undefined };
}
