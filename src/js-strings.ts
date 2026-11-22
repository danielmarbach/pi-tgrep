export interface JsStringLiteral {
  quote: string;
  contentStart: number;
  contentEnd: number;
}

export function scanJsStringLiteral(code: string, start: number): JsStringLiteral | null {
  const quote = code[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let j = start + 1;
  while (j < code.length) {
    const c = code[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return { quote, contentStart: start + 1, contentEnd: j };
    j++;
  }
  return null;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };

// Returns null for escapes that don't denote a well-defined string (legacy octal, truncated \x / \u).
export function decodeJsStringContent(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) return null;
    if (next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next];
    } else if (next === "0") {
      if (/[0-9]/.test(raw[i + 1] ?? "")) return null;
      out += "\0";
    } else if (/[1-9]/.test(next)) {
      return null;
    } else if (next === "x") {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (next === "u") {
      const braced = /^\{([0-9a-fA-F]+)\}/.exec(raw.slice(i + 1));
      let hex: string;
      if (braced) {
        hex = braced[1]!;
        i += braced[0].length;
      } else {
        hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        i += 4;
      }
      const codePoint = parseInt(hex, 16);
      if (codePoint > 0x10ffff) return null;
      out += String.fromCodePoint(codePoint);
    } else if (next === "\r") {
      if (raw[i + 1] === "\n") i++;
    } else if (next !== "\n" && next !== "\u2028" && next !== "\u2029") {
      out += next;
    }
  }
  return out;
}

export function encodeJsStringContent(text: string, quote: string): string {
  let out = "";
  for (const c of text) {
    if (c === "\\") out += "\\\\";
    else if (c === quote) out += `\\${c}`;
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else out += c;
  }
  return out;
}
