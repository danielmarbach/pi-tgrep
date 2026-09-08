import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

export type TgrepStatus =
  | { kind: "server"; pid: number; port: number; files: number; watcherActive: boolean; indexingComplete: boolean }
  | { kind: "index"; files: number }
  | { kind: "none" };

export interface ServeInfo {
  pid: number;
  port: number;
}

let cachedBinary: string | null | undefined;

export async function findTgrep(pi: ExtensionAPI): Promise<string | null> {
  if (cachedBinary !== undefined) return cachedBinary;
  try {
    const result = await pi.exec("which", ["tgrep"], { timeout: 5_000 });
    const first = result.stdout.trim().split("\n")[0];
    cachedBinary = result.code === 0 && first ? first : null;
  } catch {
    cachedBinary = null;
  }
  return cachedBinary;
}

export function resetBinaryCache(): void {
  cachedBinary = undefined;
}

function parseNumber(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
}

export async function readServeJson(root: string): Promise<ServeInfo | null> {
  try {
    const raw = await readFile(path.join(root, ".tgrep", "serve.json"), "utf-8");
    const parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown };
    if (typeof parsed.pid === "number" && typeof parsed.port === "number") {
      return { pid: parsed.pid, port: parsed.port };
    }
  } catch {}
  return null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function statusText(pi: ExtensionAPI, root: string): Promise<string> {
  try {
    const result = await pi.exec("tgrep", ["status", root], { timeout: 15_000 });
    return result.stdout;
  } catch {
    return "";
  }
}

export async function status(pi: ExtensionAPI, root: string): Promise<TgrepStatus> {
  let text = await statusText(pi, root);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (/^Server status for/m.test(text)) {
      return {
        kind: "server",
        pid: parseNumber(text, /PID:\s*(\d+)/) ?? 0,
        port: parseNumber(text, /Port:\s*(\d+)/) ?? 0,
        files: parseNumber(text, /Files:\s*(\d+)/) ?? 0,
        watcherActive: /Watcher:\s*active/.test(text),
        indexingComplete: /Indexing:\s*complete/.test(text),
      };
    }
    if (!/^Index status for/m.test(text)) return { kind: "none" };
    const serve = await readServeJson(root);
    if (!serve || !pidAlive(serve.pid)) {
      return { kind: "index", files: parseNumber(text, /Files:\s*(\d+)/) ?? 0 };
    }
    text = await statusText(pi, root);
  }
  const serve = await readServeJson(root);
  if (serve && pidAlive(serve.pid)) {
    return { kind: "server", pid: serve.pid, port: serve.port, files: 0, watcherActive: false, indexingComplete: false };
  }
  return { kind: "index", files: parseNumber(text, /Files:\s*(\d+)/) ?? 0 };
}

export async function stopServer(pi: ExtensionAPI, root: string): Promise<boolean> {
  const serve = await readServeJson(root);
  if (!serve || !pidAlive(serve.pid)) {
    await rm(path.join(root, ".tgrep", "serve.json"), { force: true }).catch(() => {});
    return false;
  }
  let isTgrep = false;
  try {
    const ps = await pi.exec("ps", ["-p", String(serve.pid), "-o", "comm="], { timeout: 5_000 });
    isTgrep = ps.code === 0 && /(^|\/)tgrep(\s|$)/.test(ps.stdout.trim());
  } catch {}
  if (!isTgrep) {
    await rm(path.join(root, ".tgrep", "serve.json"), { force: true }).catch(() => {});
    return false;
  }
  try {
    process.kill(serve.pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let waited = 0; waited < 3_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!pidAlive(serve.pid)) {
      await rm(path.join(root, ".tgrep", "serve.json"), { force: true }).catch(() => {});
      return true;
    }
  }
  try {
    process.kill(serve.pid, "SIGKILL");
  } catch {}
  await rm(path.join(root, ".tgrep", "serve.json"), { force: true }).catch(() => {});
  return true;
}
