import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KNOWN_IDENTITY_VECTORS,
  V1_SOURCE_KIND,
  V1_SOURCE_SHA256,
  V6_SOURCE_SHA256,
  assertKnownVectors,
  isProvableSourceId,
  quarantineIdentity,
  rawRowCanonicalSha256,
  recordIdentity,
  sha256Utf8,
} from "../../src/import/identity.js";

const COLLECTION = "dailyRecords";

describe("P2-4 frozen identity vectors", () => {
  it("recomputes every committed vector byte-for-byte", () => {
    for (const vector of KNOWN_IDENTITY_VECTORS) {
      expect(sha256Utf8(vector.bytes), vector.id).toBe(vector.hash);
    }
    expect(() => assertKnownVectors()).not.toThrow();
  });

  it("reproduces V1-V6 from the canonical tuple inputs", () => {
    const kind = V1_SOURCE_KIND;
    const sha = V1_SOURCE_SHA256;
    expect(recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: COLLECTION, sourceRecordId: "legacy-2026-08-01-001" }))
      .toBe("9820db706590270d8b714764407de8d89afbddb4ed4fb95ca4973ce5d48c1e24");
    expect(recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: COLLECTION, sourceRecordId: 42 }))
      .toBe("9b82659f32505dd4e0179d405f268c55f2310a651da96ecaeb03ea482abccbe8");
    expect(recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: COLLECTION, sourceRecordId: "café" }))
      .toBe("b25bfe4da3293e2e87bfa33633a34c59ac9f0e288679cc189f3729f6b95d0a32");
    expect(recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: "ab", sourceRecordId: "c" }))
      .toBe("2c73d6acbae7f036f6332b81887d790bd93ed79e06c9c7082a521fcb4119944a");
    expect(recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: "a", sourceRecordId: "bc" }))
      .toBe("d60212cc53f784f272b5271ab57a73e2ca3f08b77621eb262d7afcad7429a8b1");
  });

  it("NFC normalizes source IDs before hashing", () => {
    const kind = V1_SOURCE_KIND;
    const sha = V1_SOURCE_SHA256;
    expect(recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: COLLECTION, sourceRecordId: "cafe\u0301" }))
      .toBe(recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: COLLECTION, sourceRecordId: "caf\u00e9" }));
  });

  it("separates tuple boundaries and cross-source quarantine namespaces", () => {
    const kind = V1_SOURCE_KIND;
    const row = { qty: 2.5, note: "乳量", id: "r-9" };
    const rowSha = rawRowCanonicalSha256(row);
    expect(rowSha).toBe("42c04b184752e45f2be10e0ef8269708f33f264ea552e5f93b38d39de6355708");
    const a = quarantineIdentity({
      sourceKind: kind,
      sourceSha256: V1_SOURCE_SHA256,
      collection: COLLECTION,
      rawRowCanonicalSha256: rowSha,
      sourceOrdinal: 3,
    });
    const b = quarantineIdentity({
      sourceKind: kind,
      sourceSha256: V6_SOURCE_SHA256,
      collection: COLLECTION,
      rawRowCanonicalSha256: rowSha,
      sourceOrdinal: 3,
    });
    expect(a).toBe("e336926640a38fcc5061f098f708e6bad82a2c88da51bcca83ef0755549e4f33");
    expect(b).toBe("6c55d8371e3befe0e3684662e94cc77bad4a932cd89ccac0df3302fed5cb5f0e");
    expect(a).not.toBe(b);
    // replay stability: same inputs always produce the same identity
    expect(quarantineIdentity({
      sourceKind: kind,
      sourceSha256: V1_SOURCE_SHA256,
      collection: COLLECTION,
      rawRowCanonicalSha256: rowSha,
      sourceOrdinal: 3,
    })).toBe(a);
  });

  it("accepts only string or safe-integer source IDs", () => {
    expect(isProvableSourceId("x")).toBe(true);
    expect(isProvableSourceId(7)).toBe(true);
    expect(isProvableSourceId(1.5)).toBe(false);
    expect(isProvableSourceId(null)).toBe(false);
    expect(isProvableSourceId(true)).toBe(false);
    expect(isProvableSourceId({})).toBe(false);
    expect(isProvableSourceId(["a"])).toBe(false);
  });

  it("keeps record and quarantine spaces disjoint via the discriminator", () => {
    const kind = V1_SOURCE_KIND;
    const sha = V1_SOURCE_SHA256;
    const record = recordIdentity({ sourceKind: kind, sourceSha256: sha, collection: COLLECTION, sourceRecordId: "r-9" });
    const quarantine = quarantineIdentity({
      sourceKind: kind,
      sourceSha256: sha,
      collection: COLLECTION,
      rawRowCanonicalSha256: rawRowCanonicalSha256({ id: "r-9" }),
      sourceOrdinal: 0,
    });
    expect(record).not.toBe(quarantine);
    // sanity: the committed byte strings must themselves be reproducible
    expect(createHash("sha256").update(KNOWN_IDENTITY_VECTORS[0].bytes, "utf8").digest("hex")).toBe(
      KNOWN_IDENTITY_VECTORS[0].hash,
    );
  });
});
