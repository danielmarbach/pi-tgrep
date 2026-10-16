const WORD_CHAR = /[A-Za-z0-9_]/;
const ESCAPABLE_PUNCTUATION = /^[!-/:-@[-_{-~]$/;
const BRACKET_CLASS_NAMES = new Set([
  "alpha", "digit", "alnum", "upper", "lower", "space", "blank", "punct", "print", "graph", "cntrl", "xdigit",
]);
const INTERVAL = /^(\d+)(?:,(\d*))?$/;

type Previous = "start" | "caret" | "atom" | "quantifier" | "anchor";

/** End index (after the closing `]`) of the bracket expression opening at `open`, or -1 when it can't be copied unchanged. */
function bracketEnd(pattern: string, open: number): number {
  let i = open + 1;
  if (pattern[i] === "^") i++;
  if (pattern[i] === "]") i++;
  for (; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "]") return i + 1;
    // A backslash is literal in POSIX but an escape in tgrep's engine, and `&&`, `~~`, `--` are set operators there.
    if (c === "\\" || ((c === "&" || c === "~" || c === "-") && pattern[i + 1] === c)) return -1;
    if (c === "[") {
      const close = pattern.indexOf(":]", i + 2);
      if (pattern[i + 1] !== ":" || close === -1 || !BRACKET_CLASS_NAMES.has(pattern.slice(i + 2, close))) return -1;
      i = close + 1;
    }
  }
  return -1;
}

/** True when the atom starting at `at` (a word character or `\w`) must match at least once. */
function startsWithRequiredWord(pattern: string, at: number): boolean {
  let end: number;
  if (pattern[at] === "\\" && pattern[at + 1] === "w") end = at + 2;
  else if (pattern[at] !== undefined && WORD_CHAR.test(pattern[at]!)) end = at + 1;
  else return false;
  return pattern[end] !== "*" && !(pattern[end] === "\\" && (pattern[end + 1] === "?" || pattern[end + 1] === "{"));
}

/**
 * Converts a GNU BRE pattern to the ERE syntax tgrep understands, or returns null when the
 * conversion can't be shown to keep the meaning (back-references, GNU-only escapes, odd brackets).
 */
export function breToEre(pattern: string): string | null {
  if (pattern.includes("\n")) return null;
  let out = "";
  let previous: Previous = "start";
  let lastWord = false;
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[++i];
      if (n === undefined) return null;
      switch (n) {
        case "|":
          // An empty branch is undefined in POSIX; BSD and GNU grep disagree on it.
          if (previous === "start" || previous === "caret") return null;
          out += "|";
          previous = "start";
          break;
        case "(":
          depth++;
          out += "(";
          previous = "start";
          break;
        case ")":
          if (depth === 0 || previous === "start" || previous === "caret") return null;
          depth--;
          out += ")";
          previous = "atom";
          lastWord = false;
          break;
        case "{": {
          const close = pattern.indexOf("\\}", i + 1);
          if (previous !== "atom" || close === -1) return null;
          const body = pattern.slice(i + 1, close);
          const interval = INTERVAL.exec(body);
          if (!interval || (interval[2] ? Number(interval[1]) > Number(interval[2]) : false)) return null;
          out += `{${body}}`;
          previous = "quantifier";
          lastWord = false;
          i = close + 1;
          break;
        }
        case "+":
        case "?":
          if (previous !== "atom") return null;
          out += n;
          previous = "quantifier";
          if (n === "?") lastWord = false;
          break;
        case "<":
          if (!startsWithRequiredWord(pattern, i + 1)) return null;
          out += "\\b";
          previous = "anchor";
          break;
        case ">":
          if ((previous !== "atom" && previous !== "quantifier") || !lastWord) return null;
          out += "\\b";
          previous = "anchor";
          break;
        case "w":
        case "W":
        case "s":
        case "S":
          out += `\\${n}`;
          previous = "atom";
          lastWord = n === "w";
          break;
        case "b":
        case "B":
          out += `\\${n}`;
          previous = "anchor";
          break;
        default:
          // Back-references, `\d`-style letters, `\'` and `\`` mean something else to grep than to tgrep.
          if (n === "'" || !ESCAPABLE_PUNCTUATION.test(n) || n === "}") return null;
          out += `\\${n}`;
          previous = "atom";
          lastWord = false;
      }
      continue;
    }
    switch (c) {
      case "[": {
        const end = bracketEnd(pattern, i);
        if (end === -1) return null;
        out += pattern.slice(i, end);
        i = end - 1;
        previous = "atom";
        lastWord = false;
        break;
      }
      case "*":
        if (previous === "start" || previous === "caret") {
          out += "\\*";
          previous = "atom";
        } else if (previous === "atom") {
          out += "*";
          previous = "quantifier";
        } else {
          return null;
        }
        lastWord = false;
        break;
      case "^":
        if (previous === "start") {
          out += "^";
          previous = "caret";
        } else {
          out += "\\^";
          previous = "atom";
        }
        lastWord = false;
        break;
      case "$": {
        const rest = pattern.slice(i + 1);
        // BSD grep reads `$` before `\|` as a literal while GNU grep anchors it, so neither reading is safe.
        if (rest.startsWith("\\|")) return null;
        if (rest === "" || rest.startsWith("\\)")) {
          out += "$";
          previous = "anchor";
        } else {
          out += "\\$";
          previous = "atom";
        }
        lastWord = false;
        break;
      }
      case "(":
      case ")":
      case "{":
      case "}":
      case "+":
      case "?":
      case "|":
        out += `\\${c}`;
        previous = "atom";
        lastWord = false;
        break;
      default:
        out += c;
        previous = "atom";
        lastWord = WORD_CHAR.test(c);
    }
  }
  return depth === 0 && (previous !== "start" || pattern === "") ? out : null;
}
