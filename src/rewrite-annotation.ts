interface TextLike {
  type: string;
  text?: string;
}

const MAX_COMMAND_LEN = 200;

function truncateCommand(command: string): string {
  if (command.length <= MAX_COMMAND_LEN) return command;
  return `${command.slice(0, MAX_COMMAND_LEN - 1)}…`;
}

// The bash tool renders a run with no stdout/stderr as the literal string "(no output)",
// so that (not just "") is what a silently-failed rewrite looks like to the model.
export function isEmptyBashOutput(content: readonly TextLike[]): boolean {
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  return text === "" || text === "(no output)";
}

export function buildRewriteNote(command: string, original: string): string {
  return `[pi-tgrep] ran \`${truncateCommand(command)}\` in place of \`${truncateCommand(original)}\``;
}
