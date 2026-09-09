export type AutoInstallPolicy = "ask" | "never" | "always";
export type BashPolicyMode = "translate" | "block" | "warn" | "off";
export type SessionScope = "repo" | "session";

const DEFAULT_WATCHED_TOOLS = ["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"];

export interface TgrepConfig {
  disabled: boolean;
  autoInstall: AutoInstallPolicy;
  bashPolicy: BashPolicyMode;
  serveArgs: string[];
  indexPath?: string;
  scope: SessionScope;
  watchedTools: string[];
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function loadConfig(): TgrepConfig {
  const serveArgsRaw = env("PI_TGREP_SERVE_ARGS");
  const watchRaw = env("PI_TGREP_WATCH_TOOLS");
  return {
    disabled: env("PI_TGREP_DISABLED") === "1" || env("PI_TGREP_DISABLED") === "true",
    autoInstall: oneOf(env("PI_TGREP_AUTO_INSTALL"), ["ask", "never", "always"] as const, "ask"),
    bashPolicy: oneOf(env("PI_TGREP_BASH_POLICY"), ["translate", "block", "warn", "off"] as const, "translate"),
    serveArgs: serveArgsRaw ? serveArgsRaw.split(/\s+/).filter(Boolean) : [],
    indexPath: env("PI_TGREP_INDEX_PATH"),
    scope: oneOf(env("PI_TGREP_SCOPE"), ["repo", "session"] as const, "repo"),
    watchedTools: [
      ...DEFAULT_WATCHED_TOOLS,
      ...(watchRaw ? watchRaw.split(",").map((s) => s.trim()).filter(Boolean) : []),
    ],
  };
}
