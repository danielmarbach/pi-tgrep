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
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { Type, type Static } from "typebox";
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
  const args = ["--json", "--line-number", "--color=never", "--hidden", "--no-messages"];
  if (index?.indexDirExists && isInsideRoot(index.root, searchPath)) {
    args.push("--index-path", resolveIndexPath(index.root));
  }
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
  searchPath: string,
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
      child = spawn(bin, buildTgrepArgs(params, searchPath, index), { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "match" && event.type !== "context") return;
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

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return true;
  }
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
      const searchPath = path.resolve(ctx.cwd, params.path || ".");

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
          index = { root, indexDirExists };
          const st = await status(pi, root, hasIndexPathOverride() ? indexDir : undefined);
          if (st.kind === "server" && !st.indexingComplete) {
            const fallback = await delegateToBuiltin({ reason: "indexing", message: "tgrep index still building" });
            if (fallback) return fallback;
          }
        }
      } catch {}

      const outcome = await runSearch(bin, params, searchPath, ctx.cwd, effectiveLimit, signal, index);
      if (outcome.aborted) throw new Error("Operation aborted");
      if (outcome.spawnError || (outcome.code !== null && outcome.code !== 0 && outcome.code !== 1 && !outcome.killedDueToLimit)) {
        const fallback = await delegateToBuiltin({
          reason: "error",
          message: outcome.spawnError?.message ?? (outcome.stderr.trim() || `tgrep exited with code ${outcome.code}`),
        });
        if (fallback) return fallback;
        if (outcome.spawnError) throw new Error(`Failed to run tgrep: ${outcome.spawnError.message}`);
        throw new Error(outcome.stderr.trim() || `tgrep exited with code ${outcome.code}`);
      }

      const isDirectory = await isDir(searchPath);
      const formatPath = (filePath: string): string => {
        if (isDirectory) {
          const relative = path.relative(searchPath, filePath);
          if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
        }
        return path.basename(filePath);
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

      if (outcome.matchCount === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: { engine: "tgrep" } };
      }

      const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: Record<string, unknown> = { engine: "tgrep" };
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

      return { content: [{ type: "text", text: output }], details };
    },
  };
}
