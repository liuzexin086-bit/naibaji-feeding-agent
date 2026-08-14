import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson, parseStrictJson } from "../../src/import/canonical-json.js";

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
