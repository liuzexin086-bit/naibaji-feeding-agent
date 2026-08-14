import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalJson,
  parseJsonWithDuplicatePaths,
  parseStrictJson,
} from "../../src/import/canonical-json.js";

describe("P2-4 canonical JSON serialization", () => {
  it("serializes primitives without whitespace", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(2.5)).toBe("2.5");
    expect(canonicalJson("a b")).toBe('"a b"');
  });

  it("normalizes -0 to 0 and rejects non-finite numbers", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
  });

  it("escapes only quote, backslash, and control characters (lowercase hex)", () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson("a\\b")).toBe('"a\\\\b"');
    expect(canonicalJson("a\n\t\u0000")).toBe('"a\\u000a\\u0009\\u0000"');
    expect(canonicalJson("café")).toBe('"café"');
  });

  it("sorts object keys by Unicode code point and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: 2, "\u4e00": 3, c: 4 })).toBe('{"a":2,"b":1,"c":4,"一":3}');
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("applies NFC normalization to each string value", () => {
    expect(canonicalJson("cafe\u0301")).toBe(canonicalJson("caf\u00e9"));
    expect(canonicalJson("cafe\u0301")).toBe('"café"');
  });

  it("makes tuple boundaries unambiguous", () => {
    expect(canonicalJson(["ab", "c"])).not.toBe(canonicalJson(["a", "bc"]));
  });

  it("sorts object keys by Unicode code point, not UTF-16 code units", () => {
    // U+E000 is a BMP code point; U+10000 is supplementary (surrogate pair).
    // UTF-16 code-unit order puts U+10000 (D800 DC00) BEFORE U+E000; the
    // frozen contract requires code-point order: U+E000 (57344) < U+10000 (65536).
    expect(canonicalJson({ "\u{10000}": 1, "\uE000": 2 })).toBe(
      '{"\uE000":2,"\u{10000}":1}',
    );
    expect("\u{10000}".localeCompare("\uE000")).toBeLessThan(0); // sanity: JS default order differs
  });

  it("rejects NFC-equivalent duplicate canonical keys", () => {
    // "é" (U+00E9) and "e\u0301" normalize to the same key: the canonical
    // representation would contain a repeated key, so it must fail closed
    expect(() => canonicalJson({ "\u00e9": 1, "e\u0301": 2 })).toThrow(
      /duplicate canonical key after NFC normalization/,
    );
  });
});

describe("P2-4 strict JSON parser", () => {
  it("parses valid JSON with escapes", () => {
    expect(parseStrictJson('{"a": [1, 2.5, true, null, "x\u00e9"]}')).toEqual({
      a: [1, 2.5, true, null, "xé"],
    });
  });

  it("rejects duplicate object keys", () => {
    expect(() => parseStrictJson('{"a": 1, "a": 2}')).toThrow(/duplicate object key "a"/);
  });

  it("rejects NFC-equivalent duplicate keys after normalization", () => {
    expect(() => parseStrictJson('{"\\u00e9": 1, "e\\u0301": 2}')).toThrow(
      /duplicate object key "é"/,
    );
  });

  it("reports duplicate-key paths while keeping last-wins values", () => {
    const parsed = parseJsonWithDuplicatePaths(
      '{"meta":{"schemaVersion":1},"batches":[{"id":"a","id":"b"}],"dailyRecords":[],"weighSamples":[],"recommendations":[],"approvals":[],"executions":[],"sceneStates":[],"modelRegistry":[],"auditLogs":[]}',
    );
    expect(parsed.duplicatePaths).toEqual(['$["batches"][0]["id"]']);
    const row = (parsed.value as { batches: Array<{ id: string }> }).batches[0];
    expect(row?.id).toBe("b"); // JSON.parse semantics: last value wins
  });

  it("rejects invalid number tokens", () => {
    for (const text of ['{"a": 01}', '{"a": 1.}', '{"a": +1}', '{"a": NaN}', '{"a": 1e}']) {
      expect(() => parseStrictJson(text), text).toThrow(CanonicalJsonError);
    }
  });

  it("rejects trailing content and unterminated strings", () => {
    expect(() => parseStrictJson("{}x")).toThrow(/trailing content/);
    expect(() => parseStrictJson('{"a": "x')).toThrow(/unterminated string/);
  });
});
