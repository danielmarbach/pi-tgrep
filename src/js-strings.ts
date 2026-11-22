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
    if (quote === "`" && c === "$" && code[j + 1] === "{") {
      const end = skipJsInterpolation(code, j);
      if (end < 0) return null;
      j = end;
      continue;
    }
    if ((c === "\n" || c === "\r") && quote !== "`") return null;
    j++;
  }
  return null;
}

// `start` is the index of `$` in `${`; returns the index after the matching `}`, or -1.
function skipJsInterpolation(code: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "'" || c === '"' || c === "`") {
      const literal = scanJsStringLiteral(code, i);
      if (!literal) return -1;
      i = literal.contentEnd + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };

// Returns null for escapes that don't denote a well-defined string (legacy octal, truncated \x / \u).
function decodeEscapes(raw: string): string | null {
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

function encodeText(text: string, quote: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") out += "\\\\";
    else if (c === quote) out += `\\${c}`;
    else if (quote === "`" && c === "$" && text[i + 1] === "{") out += "\\$";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else out += c;
  }
  return out;
}

const PLACEHOLDER = /\$\{__pi_tgrep_js_(\d+)\}/g;

export interface DecodedJsString {
  text: string;
  // Original `${…}` source for each placeholder `${__pi_tgrep_js_N}` left in `text`.
  interpolations: string[];
}

export function decodeJsStringLiteral(code: string, literal: JsStringLiteral): DecodedJsString | null {
  const interpolations: string[] = [];
  let text = "";
  let segmentStart = literal.contentStart;
  let i = literal.contentStart;
  const flush = (end: number): boolean => {
    const decoded = decodeEscapes(code.slice(segmentStart, end));
    if (decoded === null) return false;
    text += decoded;
    return true;
  };
  while (i < literal.contentEnd) {
    const c = code[i]!;
    if (c === "\\") {
      i += 2;
    } else if (literal.quote === "`" && c === "$" && code[i + 1] === "{") {
      const end = skipJsInterpolation(code, i);
      if (end < 0 || !flush(i)) return null;
      text += `\${__pi_tgrep_js_${interpolations.length}}`;
      interpolations.push(code.slice(i, end));
      i = segmentStart = end;
    } else {
      i++;
    }
  }
  return flush(literal.contentEnd) ? { text, interpolations } : null;
}

// Returns null unless every placeholder survived in `text` exactly once.
export function encodeJsStringLiteralContent(text: string, quote: string, interpolations: string[]): string | null {
  const seen = new Set<number>();
  let out = "";
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]);
    if (index >= interpolations.length || seen.has(index)) return null;
    seen.add(index);
    out += encodeText(text.slice(last, match.index), quote) + interpolations[index];
    last = match.index + match[0].length;
  }
  if (seen.size !== interpolations.length) return null;
  return out + encodeText(text.slice(last), quote);
}

// Decoded text of every string literal in `code`, including literals nested in template interpolations.
export function collectJsStringLiterals(code: string): string[] {
  const texts: string[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") {
      const eol = code.indexOf("\n", i);
      i = eol < 0 ? code.length : eol;
    } else if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close < 0 ? code.length : close + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      const literal = scanJsStringLiteral(code, i);
      if (!literal) {
        i++;
        continue;
      }
      const decoded = decodeJsStringLiteral(code, literal);
      texts.push(decoded ? decoded.text : code.slice(literal.contentStart, literal.contentEnd));
      for (const interpolation of decoded?.interpolations ?? []) {
        texts.push(...collectJsStringLiterals(interpolation.slice(2, -1)));
      }
      i = literal.contentEnd + 1;
    } else {
      i++;
    }
  }
  return texts;
}
