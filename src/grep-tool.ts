import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { Type, type Static } from "typebox";
import { isGitIgnored } from "./git-ignore.ts";
import { hasIndexPathOverride, resolveIndexPath } from "./config.ts";
import { findTgrep, status } from "./tgrep-client.ts";
import { repoRoot } from "./server-manager.ts";

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

type GrepParams = Static<typeof grepSchema>;

export interface TgrepSpawnIndex {
  root: string;
  indexDirExists: boolean;
  /** The search path is git-ignored, so tgrep must not apply parent ignore rules to it. */
  searchPathIgnored?: boolean;
}

interface SearchEvent {
  filePath: string;
  lineNumber: number;
  lineText: string;
  isMatch: boolean;
}

interface SearchOutcome {
  events: SearchEvent[];
  matchCount: number;
  stderr: string;
  code: number | null;
  killedDueToLimit: boolean;
  aborted: boolean;
  spawnError?: Error;
}

interface RgJsonPayload {
  path?: { text?: string };
  line_number?: number;
  lines?: { text?: string };
}

/** ripgrep's `--json` output is an external, untrusted stream; validate its shape before trusting field values. */
type RgJsonLine =
  | { type: "match"; data?: RgJsonPayload }
  | { type: "context"; data?: RgJsonPayload }
  | { type: "begin" | "end" | "summary"; data?: unknown };

const RG_JSON_LINE_TYPES = new Set(["match", "context", "begin", "end", "summary"]);

function parseRgJsonLine(line: string): RgJsonLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !RG_JSON_LINE_TYPES.has(type)) return null;
  return parsed as RgJsonLine;
}

const DEFAULT_LIMIT = 100;

type FallbackReason = "indexing" | "no-binary" | "error";

interface FallbackInfo {
  reason: FallbackReason;
  message?: string;
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function buildTgrepArgs(params: GrepParams, searchPath: string, index?: TgrepSpawnIndex): string[] {
  const args = ["--json", "--line-number", "--color=never", "--hidden"];
  if (index?.indexDirExists && isInsideRoot(index.root, searchPath)) {
    args.push("--index-path", resolveIndexPath(index.root));
  }
  if (index?.searchPathIgnored) args.push("--no-ignore-parent");
  if (params.ignoreCase) args.push("-i");
  if (params.literal) args.push("-F");
  if (params.glob) args.push("-g", params.glob);
  if (params.context && params.context > 0) args.push("-C", String(Math.floor(params.context)));
  args.push("--", params.pattern, searchPath);
  return args;
}

function runSearch(
  bin: string,
  params: GrepParams,
  searchPaths: SearchPaths,
  cwd: string,
  effectiveLimit: number,
  signal: AbortSignal | undefined,
  index?: TgrepSpawnIndex,
): Promise<SearchOutcome> {
  return new Promise((resolve) => {
    const outcome: SearchOutcome = {
      events: [],
      matchCount: 0,
      stderr: "",
      code: null,
      killedDueToLimit: false,
      aborted: false,
    };
    let child: ChildProcess;
    try {
      const args = [...buildTgrepArgs(params, searchPaths[0], index), ...searchPaths.slice(1)];
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      outcome.spawnError = error instanceof Error ? error : new Error(String(error));
      resolve(outcome);
      return;
    }
    const stdout = child.stdout;
    if (!stdout) {
      outcome.spawnError = new Error("tgrep produced no stdout stream");
      child.kill();
      resolve(outcome);
      return;
    }
    const rl = createInterface({ input: stdout });
    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };
    const stopChild = (dueToLimit = false) => {
      if (!child.killed) {
        if (dueToLimit) outcome.killedDueToLimit = true;
        child.kill();
      }
    };
    const onAbort = () => {
      outcome.aborted = true;
      stopChild();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      outcome.stderr += chunk.toString();
    });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const event = parseRgJsonLine(line);
      if (!event || (event.type !== "match" && event.type !== "context")) return;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const lineText = event.data?.lines?.text;
      if (!filePath || typeof lineNumber !== "number" || lineText === undefined) return;
      if (event.type === "match") {
        if (outcome.matchCount >= effectiveLimit) return;
        outcome.matchCount += 1;
        outcome.events.push({ filePath, lineNumber, lineText, isMatch: true });
        if (outcome.matchCount >= effectiveLimit) stopChild(true);
      } else if (params.context !== undefined && params.context > 0) {
        outcome.events.push({ filePath, lineNumber, lineText, isMatch: false });
      }
    });
    child.on("error", (error) => {
      cleanup();
      outcome.spawnError = error;
      resolve(outcome);
    });
    child.on("close", (code) => {
      cleanup();
      outcome.code = code;
      resolve(outcome);
    });
  });
}

type PathKind = "dir" | "file" | "missing";
type SearchPaths = [string, ...string[]];

async function pathKind(p: string): Promise<PathKind> {
  try {
    return (await stat(p)).isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

const NOT_VALID_REGEX_NOTICE = "[pi-tgrep] pattern is not a valid regex; searched literally";
const REGEX_ERROR = /regex (parse )?error/i;
const MAX_LISTED_ENTRIES = 20;

/** Models often pass several paths as one whitespace-separated string; split it only when every token exists. */
async function resolveSearchPaths(cwd: string, rawPath: string | undefined): Promise<SearchPaths | { missing: string }> {
  const whole = path.resolve(cwd, rawPath || ".");
  if ((await pathKind(whole)) !== "missing") return [whole];
  const tokens = (rawPath ?? "").split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const resolved = tokens.map((token) => path.resolve(cwd, token));
    const kinds = await Promise.all(resolved.map(pathKind));
    if (kinds.every((kind) => kind !== "missing")) return [resolved[0] as string, ...resolved.slice(1)];
  }
  return { missing: whole };
}

async function describeMissingPath(missing: string): Promise<string> {
  let parent = path.dirname(missing);
  while ((await pathKind(parent)) !== "dir" && path.dirname(parent) !== parent) parent = path.dirname(parent);
  const message = [`Path not found: ${missing}`];
  try {
    const entries = (await readdir(parent, { withFileTypes: true }))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    const listed = entries.slice(0, MAX_LISTED_ENTRIES).join(", ");
    const more = entries.length > MAX_LISTED_ENTRIES ? `, … (${entries.length - MAX_LISTED_ENTRIES} more)` : "";
    message.push(`Nearest existing directory: ${parent}`, `Entries: ${listed || "(empty)"}${more}`);
  } catch {
    message.push(`Nearest existing directory: ${parent}`);
  }
  return message.join("\n");
}

function searchFailed(outcome: SearchOutcome): boolean {
  return Boolean(
    outcome.spawnError || (outcome.code !== null && outcome.code !== 0 && outcome.code !== 1 && !outcome.killedDueToLimit),
  );
}

function describeSearchFailure(outcome: SearchOutcome): string {
  if (outcome.spawnError) return outcome.spawnError.message;
  const reason = outcome.stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !/^(warning|note):/.test(line));
  return reason ?? `tgrep exited with code ${outcome.code}`;
}

export function createGrepToolOverride(pi: ExtensionAPI): ToolDefinition<typeof grepSchema> {
  return {
    name: "grep",
    label: "grep",
    description:
      "Search file contents for a pattern using the tgrep trigram index (auto-indexed). Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
    promptSnippet: "Search file contents via the tgrep trigram index (fast on large repos)",
    promptGuidelines: [
      "Use grep for code search; it is tgrep-backed and indexed. Do not run grep/rg in bash — the grep tool is faster.",
    ],
    parameters: grepSchema,
    async execute(
      toolCallId: string,
      params: GrepParams,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const effectiveLimit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT));
      const resolvedPaths = await resolveSearchPaths(ctx.cwd, params.path);
      if (!Array.isArray(resolvedPaths)) throw new Error(await describeMissingPath(resolvedPaths.missing));
      const searchPaths = resolvedPaths;

      const delegateToBuiltin = async (fallback: FallbackInfo): Promise<AgentToolResult<unknown> | null> => {
        try {
          const builtin = createGrepToolDefinition(ctx.cwd);
          const result = await builtin.execute(toolCallId, params, signal, onUpdate, ctx);
          return { ...result, details: { engine: "rg-fallback", fallback, ...(result.details ?? {}) } };
        } catch {
          return null;
        }
      };

      const bin = await findTgrep(pi);
      if (!bin) {
        const fallback = await delegateToBuiltin({ reason: "no-binary", message: "tgrep binary not found" });
        if (fallback) return fallback;
        throw new Error("tgrep is not available and the ripgrep fallback failed");
      }
      let index: TgrepSpawnIndex | undefined;
      try {
        const root = await repoRoot(ctx.cwd);
        if (root) {
          const indexDir = resolveIndexPath(root);
          let indexDirExists = false;
          try {
            indexDirExists = (await stat(indexDir)).isDirectory();
          } catch {}
          index = { root, indexDirExists, searchPathIgnored: (await Promise.all(searchPaths.map((p) => isGitIgnored(root, p)))).some(Boolean) };
          const st = await status(pi, root, hasIndexPathOverride() ? indexDir : undefined);
          if (st.kind === "server" && !st.indexingComplete) {
            const fallback = await delegateToBuiltin({ reason: "indexing", message: "tgrep index still building" });
            if (fallback) return fallback;
          }
        }
      } catch {}

      const spawnIndex = index && searchPaths.every((p) => isInsideRoot(index.root, p)) ? index : undefined;
      let outcome = await runSearch(bin, params, searchPaths, ctx.cwd, effectiveLimit, signal, spawnIndex);
      if (outcome.aborted) throw new Error("Operation aborted");
      let regexFallback = false;
      if (outcome.code === 2 && !params.literal && REGEX_ERROR.test(outcome.stderr)) {
        const literalOutcome = await runSearch(bin, { ...params, literal: true }, searchPaths, ctx.cwd, effectiveLimit, signal, spawnIndex);
        if (literalOutcome.aborted) throw new Error("Operation aborted");
        if (!searchFailed(literalOutcome)) {
          outcome = literalOutcome;
          regexFallback = true;
        }
      }
      if (searchFailed(outcome)) {
        const failure = describeSearchFailure(outcome);
        const fallback = await delegateToBuiltin({ reason: "error", message: failure });
        if (fallback) return fallback;
        throw new Error(outcome.spawnError ? `Failed to run tgrep: ${failure}` : failure);
      }

      const searchPath = searchPaths[0];
      const isDirectory = searchPaths.length === 1 && (await pathKind(searchPath)) === "dir";
      const formatPath = (filePath: string): string => {
        const base = isDirectory ? searchPath : ctx.cwd;
        if (isDirectory || searchPaths.length > 1) {
          const relative = path.relative(base, filePath);
          if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
        }
        return searchPaths.length > 1 ? filePath : path.basename(filePath);
      };

      const seen = new Set<string>();
      const outputLines: string[] = [];
      let linesTruncated = false;
      for (const event of outcome.events) {
        const key = `${event.filePath}:${event.lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sanitized = event.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
        const { text, wasTruncated } = truncateLine(sanitized);
        if (wasTruncated) linesTruncated = true;
        const relPath = formatPath(event.filePath);
        outputLines.push(event.isMatch ? `${relPath}:${event.lineNumber}: ${text}` : `${relPath}-${event.lineNumber}- ${text}`);
      }

      const details: Record<string, unknown> = { engine: "tgrep" };
      if (regexFallback) details.regexFallback = true;
      if (searchPaths.length > 1) details.searchPaths = searchPaths;

      if (outcome.matchCount === 0) {
        const text = regexFallback ? `No matches found\n\n${NOT_VALID_REGEX_NOTICE}` : "No matches found";
        return { content: [{ type: "text", text }], details };
      }

      const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const notices: string[] = [];
      if (outcome.killedDueToLimit) {
        notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.matchLimitReached = effectiveLimit;
        details.truncated = true;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
        details.linesTruncated = true;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      if (regexFallback) output += `\n\n${NOT_VALID_REGEX_NOTICE}`;

      return { content: [{ type: "text", text: output }], details };
    },
  };
}
