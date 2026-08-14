/**
 * P2-4 frozen canonical JSON serialization (CJSON) - contract 5.1.
 *
 * CJSON operates on parsed JSON values, never on raw source text:
 * - object keys are sorted by Unicode code point ascending; duplicate keys are
 *   rejected by parseStrictJson (a row with duplicate keys is not canonically
 *   serializable and is quarantined by the importer);
 * - array element order is preserved;
 * - each string value is Unicode NFC-normalized before serialization; no
 *   normalization is applied across JSON string boundaries;
 * - strings are wrapped in double quotes; only double-quote, backslash, and
 *   U+0000-U+001F (as uXXXX with lowercase hex) are escaped; every other code
 *   point, including non-ASCII and surrogate pairs, is emitted verbatim as UTF-8;
 * - numbers use the ECMAScript shortest round-trip decimal representation
 *   (identical to Number::toString / JSON.stringify numeric output); -0
 *   serializes as 0; non-finite numbers are invalid;
 * - no whitespace is emitted between tokens.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function escapeString(value: string): string {
  let out = '"';
  for (const ch of value.normalize("NFC")) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (cp < 0x20) {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return escapeString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("non-finite numbers are invalid in CJSON");
    }
    if (Object.is(value, -0)) return "0";
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
      "{" +
      keys.map((key) => escapeString(key) + ":" + canonicalize(record[key])).join(",") +
      "}"
    );
  }
  throw new CanonicalJsonError("unsupported CJSON value: " + typeof value);
}

/** Frozen canonical JSON serialization. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

const NUMBER_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Strict JSON parser used by the import pipeline. It rejects duplicate object
 * keys (JSON.parse silently keeps the last occurrence, which would make the
 * canonical encoding ambiguous) and enforces the JSON number grammar.
 */
export function parseStrictJson(text: string): unknown {
  let index = 0;
  const input = text;

  function skipWhitespace(): void {
    while (index < input.length) {
      const ch = input[index];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        index += 1;
      } else {
        break;
      }
    }
  }

  function parseValue(depth: number): unknown {
    if (depth > 512) throw new CanonicalJsonError("JSON nesting too deep");
    skipWhitespace();
    const ch = input[index];
    if (ch === undefined) throw new CanonicalJsonError("unexpected end of JSON");
    if (ch === "{") return parseObject(depth + 1);
    if (ch === "[") return parseArray(depth + 1);
    if (ch === '"') return parseString();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    if (input.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (input.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (input.startsWith("null", index)) {
      index += 4;
      return null;
    }
    throw new CanonicalJsonError("unexpected token at offset " + index);
  }

  function parseString(): string {
    if (input[index] !== '"') throw new CanonicalJsonError("expected string");
    index += 1;
    let out = "";
    while (index < input.length) {
      const ch = input[index] as string;
      if (ch === '"') {
        index += 1;
        return out;
      }
      if (ch === "\\") {
        index += 1;
        const esc = input[index];
        if (esc === undefined) throw new CanonicalJsonError("unterminated escape");
        if (esc === '"' || esc === "\\" || esc === "/") {
          out += esc;
          index += 1;
        } else if (esc === "b") {
          out += "\b";
          index += 1;
        } else if (esc === "f") {
          out += "\f";
          index += 1;
        } else if (esc === "n") {
          out += "\n";
          index += 1;
        } else if (esc === "r") {
          out += "\r";
          index += 1;
        } else if (esc === "t") {
          out += "\t";
          index += 1;
        } else if (esc === "u") {
          const hex = input.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new CanonicalJsonError("invalid \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 5;
        } else {
          throw new CanonicalJsonError("invalid escape \\" + esc);
        }
      } else {
        if (ch.charCodeAt(0) < 0x20) throw new CanonicalJsonError("unescaped control character");
        out += ch;
        index += 1;
      }
    }
    throw new CanonicalJsonError("unterminated string");
  }

  function parseNumber(): number {
    const start = index;
    while (index < input.length && /[0-9eE+.-]/.test(input[index] as string)) {
      index += 1;
    }
    const token = input.slice(start, index);
    if (!NUMBER_TOKEN.test(token)) throw new CanonicalJsonError("invalid number token \"" + token + "\"");
    return Number(token);
  }

  function parseArray(depth: number): unknown[] {
    index += 1; // [
    const out: unknown[] = [];
    skipWhitespace();
    if (input[index] === "]") {
      index += 1;
      return out;
    }
    for (;;) {
      out.push(parseValue(depth));
      skipWhitespace();
      if (input[index] === "]") {
        index += 1;
        return out;
      }
      if (input[index] !== ",") throw new CanonicalJsonError("expected ',' or ']'");
      index += 1;
    }
  }

  function parseObject(depth: number): Record<string, unknown> {
    index += 1; // {
    const out: Record<string, unknown> = {};
    skipWhitespace();
    if (input[index] === "}") {
      index += 1;
      return out;
    }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new CanonicalJsonError("duplicate object key \"" + key + "\"");
      }
      skipWhitespace();
      if (input[index] !== ":") throw new CanonicalJsonError("expected ':'");
      index += 1;
      out[key] = parseValue(depth);
      skipWhitespace();
      if (input[index] === "}") {
        index += 1;
        return out;
      }
      if (input[index] !== ",") throw new CanonicalJsonError("expected ',' or '}'");
      index += 1;
    }
  }

  const result = parseValue(0);
  skipWhitespace();
  if (index !== input.length) throw new CanonicalJsonError("trailing content at offset " + index);
  return result;
}
