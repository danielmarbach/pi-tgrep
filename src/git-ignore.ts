import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/** True when `target` exists inside the repo at `root` and git ignores it. */
export async function isGitIgnored(root: string, target: string): Promise<boolean> {
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    await stat(target);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "check-ignore", "-q", "--", rel], { timeout: 5_000 }, (error) => resolve(error === null));
  });
}
