import { isBashToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { hasIndexPathOverride, loadConfig, resolveIndexPath } from "../src/config.ts";
import { applyToolCallPolicy, watchedKey } from "../src/watched-tools.ts";
import { createGrepToolOverride } from "../src/grep-tool.ts";
import { repoRoot, ServerManager } from "../src/server-manager.ts";
import { findTgrep, resetBinaryCache, status } from "../src/tgrep-client.ts";

const DECISIONS_FILE = path.join(homedir(), ".cache", "pi-tgrep", "auto-install.json");

async function loadDecision(): Promise<"yes" | "no" | null> {
  try {
    const raw = JSON.parse(await readFile(DECISIONS_FILE, "utf-8")) as { decision?: unknown };
    return raw.decision === "yes" || raw.decision === "no" ? raw.decision : null;
  } catch {
    return null;
  }
}

async function persistDecision(decision: "yes" | "no"): Promise<void> {
  try {
    await mkdir(path.dirname(DECISIONS_FILE), { recursive: true });
    await writeFile(DECISIONS_FILE, JSON.stringify({ decision }));
  } catch {}
}

export default function piTgrep(pi: ExtensionAPI) {
  const cfg = loadConfig();
  if (cfg.disabled) return;

  const manager = new ServerManager(pi, cfg);
  let toolRegistered = false;
  let sessionSeq = 0;
  let cachedIndexPath: string | null | undefined;
  // toolCallId -> rewritten provenance; session logs persist pre-rewrite args, so the
  // tool_result details stamp is the only observable trace of a translation
  const rewritten = new Map<string, { command: string; original: string }>();

  const shellIndexPath = async (cwd: string): Promise<string | undefined> => {
    if (cachedIndexPath !== undefined) return cachedIndexPath || undefined;
    const root = await repoRoot(cwd);
    if (!root) return undefined;
    const dir = resolveIndexPath(root);
    try {
      if (!(await stat(dir)).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    cachedIndexPath = dir;
    return dir;
  };

  const ensureToolRegistered = async (): Promise<boolean> => {
    const bin = await findTgrep(pi);
    if (!bin) return false;
    if (!toolRegistered) {
      pi.registerTool(createGrepToolOverride(pi));
      toolRegistered = true;
    }
    return true;
  };

  const tryAutoInstall = async (ctx: ExtensionContext): Promise<boolean> => {
    if (cfg.autoInstall === "never") return false;
    if (cfg.autoInstall === "ask") {
      const prior = await loadDecision();
      if (prior === "no") return false;
      if (!prior) {
        if (!ctx.hasUI) return false;
        const ok = await ctx.ui.confirm("pi-tgrep", "tgrep is not installed. Install it with brew?").catch(() => false);
        void persistDecision(ok ? "yes" : "no");
        if (!ok) return false;
      }
    }
    ctx.ui.setStatus("tgrep", "tgrep: installing via brew…");
    try {
      const res = await pi.exec("brew", ["install", "tgrep"], { timeout: 600_000 });
      if (res.code !== 0) {
        ctx.ui.notify(`pi-tgrep: brew install failed: ${res.stderr.trim().slice(0, 200)}`, "warning");
        return false;
      }
    } catch {
      return false;
    }
    resetBinaryCache();
    return ensureToolRegistered();
  };

  pi.on("session_start", async (_event, ctx) => {
    const seq = ++sessionSeq;
    const ready = await ensureToolRegistered();
    if (!ready && !(await tryAutoInstall(ctx))) return;
    const root = await repoRoot(ctx.cwd);
    if (!root) {
      ctx.ui.setStatus("tgrep", "tgrep: not a git repo");
      return;
    }
    const st = await manager.ensureRunning(root);
    ctx.ui.setStatus("tgrep", manager.describe(st));
    if (!(st.kind === "server" && st.indexingComplete)) {
      void manager.monitor(root, (line) => {
        if (seq === sessionSeq) ctx.ui.setStatus("tgrep", line);
      });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as unknown as Record<string, unknown>;
    const original = watchedKey(event.toolName, cfg.watchedTools) === "bash" && typeof input.command === "string"
      ? input.command
      : undefined;
    const context = cfg.bashPolicy === "translate" ? { indexPath: await shellIndexPath(ctx.cwd) } : undefined;
    const result = applyToolCallPolicy(event.toolName, input, cfg.bashPolicy, cfg.watchedTools, context);
    if (result.action === "block") return { block: true, reason: result.reason };
    if (result.action === "rewrite" && original !== undefined && typeof input.command === "string") {
      rewritten.set(event.toolCallId, { command: input.command, original });
    }
    if (result.action === "allow" && result.warned) {
      ctx.ui.notify("pi-tgrep: shell grep bypasses the tgrep index; prefer the grep tool", "warning");
    }
  });

  pi.on("tool_result", async (event) => {
    const stamp = rewritten.get(event.toolCallId);
    if (!stamp) return;
    rewritten.delete(event.toolCallId);
    if (!isBashToolResult(event)) return;
    return { details: { ...(event.details ?? {}), engine: "tgrep", command: stamp.command, original: stamp.original } };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionSeq++;
    rewritten.clear();
    ctx.ui.setStatus("tgrep", undefined);
    await manager.shutdown();
  });

  pi.registerCommand("tgrep-status", {
    description: "Show tgrep index/server status for this repo",
    handler: async (_args, ctx) => {
      const root = await repoRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify("tgrep: not a git repo", "info");
        return;
      }
      const st = await status(pi, root, hasIndexPathOverride() ? resolveIndexPath(root) : undefined);
      let detail = manager.describe(st);
      if (st.kind === "server") detail += `\n  PID: ${st.pid}  Port: ${st.port}  Watcher: ${st.watcherActive ? "active" : "off"}  Indexing: ${st.indexingComplete ? "complete" : "in progress"}`;
      ctx.ui.notify(detail, "info");
    },
  });

  pi.registerCommand("tgrep-reindex", {
    description: "Rebuild the tgrep index for this repo",
    handler: async (_args, ctx) => {
      const root = await repoRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify("tgrep: not a git repo", "info");
        return;
      }
      ctx.ui.notify(`tgrep: rebuilding index for ${root}…`, "info");
      ctx.ui.notify(`tgrep: ${await manager.reindex(root)}`, "info");
    },
  });

  pi.registerCommand("tgrep-stop", {
    description: "Stop the tgrep server for this repo",
    handler: async (_args, ctx) => {
      const root = await repoRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify("tgrep: not a git repo", "info");
        return;
      }
      const stopped = await manager.stop(root);
      ctx.ui.notify(stopped ? `tgrep: stopped server for ${root}` : `tgrep: no server running for ${root}`, "info");
    },
  });
}
