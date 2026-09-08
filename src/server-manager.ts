import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TgrepConfig } from "./config.ts";
import { findTgrep, status, stopServer, type TgrepStatus } from "./tgrep-client.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function repoRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      await stat(path.join(dir, ".git"));
      return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function ensureGitExclude(root: string): Promise<void> {
  let gitDir = path.join(root, ".git");
  try {
    const s = await stat(gitDir);
    if (!s.isDirectory()) {
      const raw = await readFile(gitDir, "utf-8");
      const m = /^gitdir:\s*(.+)$/m.exec(raw);
      if (m?.[1]) gitDir = path.resolve(root, m[1].trim());
      else return;
    }
  } catch {
    return;
  }
  try {
    const infoDir = path.join(gitDir, "info");
    await mkdir(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, "exclude");
    let content = "";
    try {
      content = await readFile(excludePath, "utf-8");
    } catch {}
    if (!/^\.tgrep\/?$/m.test(content)) {
      await writeFile(excludePath, (content && !content.endsWith("\n") ? `${content}\n` : content) + ".tgrep/\n");
    }
  } catch {}
}

export class ServerManager {
  private pi: ExtensionAPI;
  private cfg: TgrepConfig;
  private roots = new Set<string>();

  constructor(pi: ExtensionAPI, cfg: TgrepConfig) {
    this.pi = pi;
    this.cfg = cfg;
  }

  async ensureRunning(root: string): Promise<TgrepStatus> {
    let st = await status(this.pi, root);
    if (st.kind === "server") return st;
    const bin = await findTgrep(this.pi);
    if (!bin) return st;
    await ensureGitExclude(root);
    const args = ["serve", root, ...this.cfg.serveArgs];
    if (this.cfg.indexPath) args.push("--index-path", this.cfg.indexPath);
    try {
      const child = spawn(bin, args, { cwd: root, detached: true, stdio: "ignore" });
      child.unref();
    } catch {
      return st;
    }
    this.roots.add(root);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(250);
      st = await status(this.pi, root);
      if (st.kind === "server") return st;
    }
    return st;
  }

  describe(st: TgrepStatus): string {
    if (st.kind === "server") {
      return st.indexingComplete
        ? `tgrep: ${st.files.toLocaleString()} files`
        : `tgrep: indexing… (${st.files.toLocaleString()} files)`;
    }
    if (st.kind === "index") return `tgrep: index only, no server (${st.files.toLocaleString()} files)`;
    return "tgrep: no index";
  }

  async monitor(root: string, onUpdate: (line: string) => void, maxMs = 120_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    let noneCount = 0;
    for (;;) {
      const st = await status(this.pi, root);
      onUpdate(this.describe(st));
      if (st.kind === "server" && st.indexingComplete) return;
      if (st.kind === "index") return;
      if (st.kind === "none") {
        noneCount++;
        if (noneCount >= 2) return;
      } else {
        noneCount = 0;
      }
      if (Date.now() >= deadline) return;
      await sleep(2_000);
    }
  }

  async stop(root: string): Promise<boolean> {
    this.roots.delete(root);
    return stopServer(this.pi, root);
  }

  async reindex(root: string): Promise<string> {
    await this.stop(root);
    const res = await this.pi.exec("tgrep", ["index", root], { timeout: 600_000 });
    await this.ensureRunning(root);
    return res.code === 0 ? `reindexed ${root}` : `index failed: ${res.stderr.trim().slice(0, 300)}`;
  }

  async shutdown(): Promise<void> {
    if (this.cfg.scope !== "session") return;
    for (const root of this.roots) {
      await stopServer(this.pi, root);
    }
    this.roots.clear();
  }
}
