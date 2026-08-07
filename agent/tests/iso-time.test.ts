import { describe, expect, it } from "vitest";
import {
  normalizeIsoTimestamp,
  timestampOrderValue,
} from "../src/shared/iso-time.js";

describe("ISO timestamp contract", () => {
  it("accepts real calendar dates and rejects impossible calendar dates", () => {
    expect(normalizeIsoTimestamp("2026-02-28T10:00:00Z"))
      .toBe("2026-02-28T10:00:00.000Z");
    expect(normalizeIsoTimestamp("2026-02-29T10:00:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2028-02-29T10:00:00Z"))
      .toBe("2028-02-29T10:00:00.000Z");
    expect(normalizeIsoTimestamp("2026-04-30T10:00:00Z"))
      .toBe("2026-04-30T10:00:00.000Z");
    expect(normalizeIsoTimestamp("2026-04-31T10:00:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2026-02-31T10:00:00Z")).toBeNull();
  });

  it("rejects invalid time and offset ranges", () => {
    expect(normalizeIsoTimestamp("2026-08-05T24:00:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2026-08-05T10:60:00Z")).toBeNull();
    expect(normalizeIsoTimestamp("2026-08-05T10:00:60Z")).toBeNull();
    expect(normalizeIsoTimestamp("2026-08-05T10:00:00+24:00")).toBeNull();
    expect(normalizeIsoTimestamp("2026-08-05T10:00:00+08:00"))
      .toBe("2026-08-05T02:00:00.000Z");
  });

  it("does not let invalid legacy timestamps sort as newest", () => {
    const valid = timestampOrderValue("2026-08-05T10:00:00Z");
    expect(timestampOrderValue("2026-02-31T10:00:00Z"))
      .toBe(Number.MIN_SAFE_INTEGER);
    expect(timestampOrderValue("abc")).toBe(Number.MIN_SAFE_INTEGER);
    expect(valid).toBeGreaterThan(timestampOrderValue("abc"));
  });
});
