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

/**
 * Compare two strings by Unicode code point ascending. JS default comparison
 * is UTF-16 code-unit order, which differs for supplementary-plane code
 * points (surrogate pairs); the frozen contract requires code-point order.
 */
function compareCodePoints(left: string, right: string): number {
  const leftCps = [...left];
  const rightCps = [...right];
  const length = Math.min(leftCps.length, rightCps.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftCps[index]?.codePointAt(0) as number;
    const b = rightCps[index]?.codePointAt(0) as number;
    if (a !== b) return a < b ? -1 : 1;
  }
  return leftCps.length - rightCps.length;
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
    // keys are NFC-normalized first, sorted by Unicode code point, and
    // duplicate canonical keys (keys that normalize to the same string) are
    // rejected so the canonical representation never contains repeated keys
    const keyPairs = Object.keys(record)
      .map((original) => ({ original, normalized: original.normalize("NFC") }))
      .sort((a, b) => compareCodePoints(a.normalized, b.normalized));
    for (let index = 1; index < keyPairs.length; index += 1) {
      if (keyPairs[index]?.normalized === keyPairs[index - 1]?.normalized) {
        throw new CanonicalJsonError(
          "duplicate canonical key after NFC normalization: " + keyPairs[index]?.normalized,
        );
      }
    }
    return (
      "{" +
      keyPairs
        .map((pair) => escapeString(pair.normalized) + ":" + canonicalize(record[pair.original]))
        .join(",") +
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
 * Internal JSON parser with path tracking. When duplicate keys are found,
 * the handler is invoked with the canonical path (for example
 * $[\"batches\"][3][\"id\"]) and the LAST value wins (JSON.parse
 * semantics); when no handler is provided, duplicate keys are rejected.
 */
function parseJsonInternal(
  text: string,
  onDuplicateKey: ((path: string, key: string) => void) | null,
): { value: unknown; spans: Map<string, ValueSpan> } {
  let index = 0;
  const input = text;
  const spans = new Map<string, { start: number; end: number }>();

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

  function parseValue(depth: number, path: string): unknown {
    if (depth > 512) throw new CanonicalJsonError("JSON nesting too deep");
    skipWhitespace();
    const start = index;
    const ch = input[index];
    let value: unknown;
    if (ch === undefined) throw new CanonicalJsonError("unexpected end of JSON");
    if (ch === "{") {
      value = parseObject(depth + 1, path);
    } else if (ch === "[") {
      value = parseArray(depth + 1, path);
    } else if (ch === '"') {
      value = parseString();
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      value = parseNumber();
    } else if (input.startsWith("true", index)) {
      index += 4;
      value = true;
    } else if (input.startsWith("false", index)) {
      index += 5;
      value = false;
    } else if (input.startsWith("null", index)) {
      index += 4;
      value = null;
    } else {
      throw new CanonicalJsonError("unexpected token at offset " + index);
    }
    spans.set(path, { start, end: index });
    return value;
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

  function parseArray(depth: number, path: string): unknown[] {
    index += 1; // [
    const out: unknown[] = [];
    skipWhitespace();
    if (input[index] === "]") {
      index += 1;
      return out;
    }
    let elementIndex = 0;
    for (;;) {
      out.push(parseValue(depth, path + "[" + elementIndex + "]"));
      elementIndex += 1;
      skipWhitespace();
      if (input[index] === "]") {
        index += 1;
        return out;
      }
      if (input[index] !== ",") throw new CanonicalJsonError("expected ',' or ']'");
      index += 1;
    }
  }

  function parseObject(depth: number, path: string): Record<string, unknown> {
    index += 1; // {
    const out: Record<string, unknown> = {};
    skipWhitespace();
    if (input[index] === "}") {
      index += 1;
      return out;
    }
    for (;;) {
      skipWhitespace();
      // keys are NFC-normalized before the duplicate check so NFC-equivalent
      // keys ("\u00e9" vs "e\u0301") cannot both pass and later collide in CJSON
      const key = parseString().normalize("NFC");
      const keyPath = path + "[\"" + key + "\"]";
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        if (onDuplicateKey) {
          onDuplicateKey(keyPath, key);
        } else {
          throw new CanonicalJsonError("duplicate object key \"" + key + "\"");
        }
      }
      skipWhitespace();
      if (input[index] !== ":") throw new CanonicalJsonError("expected ':'");
      index += 1;
      out[key] = parseValue(depth, keyPath);
      skipWhitespace();
      if (input[index] === "}") {
        index += 1;
        return out;
      }
      if (input[index] !== ",") throw new CanonicalJsonError("expected ',' or '}'");
      index += 1;
    }
  }

  const result = parseValue(0, "$");
  skipWhitespace();
  if (index !== input.length) throw new CanonicalJsonError("trailing content at offset " + index);
  return { value: result, spans };
}

export interface ValueSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Strict JSON parser used by the import pipeline. It rejects duplicate object
 * keys (JSON.parse silently keeps the last occurrence, which would make the
 * canonical encoding ambiguous) and enforces the JSON number grammar.
 */
export function parseStrictJson(text: string): unknown {
  return parseJsonInternal(text, null).value;
}

export interface ParsedJsonWithDuplicatePaths {
  readonly value: unknown;
  /** Canonical paths of duplicate keys, for example $["batches"][3]["id"]. */
  readonly duplicatePaths: readonly string[];
  /**
   * Byte offsets of every parsed value keyed by canonical path. The importer
   * uses them to preserve the ORIGINAL source row/value text (including any
   * duplicate keys) as lossless evidence instead of re-serializing the
   * last-value-wins parse.
   */
  readonly spans: ReadonlyMap<string, ValueSpan>;
}

/**
 * Tolerant parser for source documents: keeps the last value for duplicate
 * keys (JSON.parse semantics) while reporting every duplicate-key path so the
 * importer can quarantine the affected row (contract 5.1) instead of failing
 * the whole source.
 */
export function parseJsonWithDuplicatePaths(text: string): ParsedJsonWithDuplicatePaths {
  const duplicatePaths: string[] = [];
  const { value, spans } = parseJsonInternal(text, (path) => {
    duplicatePaths.push(path);
  });
  return { value, duplicatePaths, spans };
}
