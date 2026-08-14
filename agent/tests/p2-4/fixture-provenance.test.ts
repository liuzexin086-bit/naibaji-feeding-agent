import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_ROOT,
  fixturePath,
  loadFixtureManifest,
  sha256File,
} from "./helpers.js";

const manifest = loadFixtureManifest();

describe("P2-4 sanitized real JSON Database v1 fixture", () => {
  it("binds immutable bytes, size, origin, and sanitization assertions", () => {
    const base = manifest.baseRealFixture;
    expect(sha256File(fixturePath(base.fixture))).toBe(base.sha256);
    expect(readFileSync(fixturePath(base.fixture), "utf8").length).toBe(base.byteSize);
    expect(base.rawSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(base.rawSourceByteSize).toBeGreaterThan(0);
    expect(base.sourceOrigin).toMatchObject({
      kind: "real local Electron userData JSON Database v1 file",
      capturedPurpose: "real operator JSON Database v1 source for the P2-4 import fixture",
      capturedDate: "2026-07-07",
    });
    expect(base.sourceOrigin.path).toContain("naibaji-db.json");
    expect(base.observedSourceState).toContain("schemaVersion=1");
    expect(base.sanitizationRecord).toMatchObject({
      secretsPresent: false,
      personalDataPresent: false,
      liveEndpointsPresent: false,
      deviceControlAuthorityPresent: false,
    });
    expect(manifest.formatVersion).toBe(1);
  });

  it("preserves the frozen envelope and collection inventory", () => {
    const text = readFileSync(fixturePath(manifest.baseRealFixture.fixture), "utf8");
    const parsed = JSON.parse(text) as {
      meta: { schemaVersion: number };
      batches: unknown[];
      dailyRecords: unknown[];
      weighSamples: unknown[];
      recommendations: unknown[];
      approvals: unknown[];
      executions: unknown[];
      sceneStates: unknown[];
      modelRegistry: unknown[];
      auditLogs: unknown[];
    };
    expect(parsed.meta.schemaVersion).toBe(1);
    expect(parsed.batches.length).toBe(5);
    expect(parsed.dailyRecords.length).toBe(19);
    expect(parsed.weighSamples.length).toBe(0);
    expect(parsed.recommendations.length).toBe(19);
    expect(parsed.approvals.length).toBe(0);
    expect(parsed.executions.length).toBe(0);
    expect(parsed.sceneStates.length).toBe(2);
    expect(parsed.modelRegistry.length).toBe(2);
    expect(parsed.auditLogs.length).toBe(0);
  });

  it("keeps cross-collection references coherent through the id map", () => {
    const text = readFileSync(fixturePath(manifest.baseRealFixture.fixture), "utf8");
    const parsed = JSON.parse(text) as {
      batches: Array<{ id: string }>;
      dailyRecords: Array<{ id: string; batchId: string }>;
      recommendations: Array<{ id: string; batchId: string; dailyRecordId: string }>;
    };
    const batchIds = new Set(parsed.batches.map((row) => row.id));
    const recordIds = new Set(parsed.dailyRecords.map((row) => row.id));
    for (const row of parsed.dailyRecords) expect(batchIds.has(row.batchId)).toBe(true);
    for (const row of parsed.recommendations) {
      expect(batchIds.has(row.batchId)).toBe(true);
      expect(recordIds.has(row.dailyRecordId)).toBe(true);
    }
  });

  it("contains no original identifiers, timestamps, CJK text, or personal markers", () => {
    const text = readFileSync(fixturePath(manifest.baseRealFixture.fixture), "utf8");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    expect(text).not.toMatch(/2026-07-0[0-9]T/);
    expect(text).not.toMatch(/@/);
    expect(text).not.toContain("AppData");
    expect(text).not.toContain(manifest.baseRealFixture.rawSourceSha256);
    expect(text).toMatch(/"fixture-id-\d+"/);
  });

  it("binds every variant and owner-mapping hash in the manifest", () => {
    for (const entry of [...manifest.variants, ...manifest.ownerMappings]) {
      const path = fixturePath(entry.fixture);
      expect(sha256File(path), entry.fixture).toBe(entry.sha256);
      expect(readFileSync(path, "utf8").length, entry.fixture).toBe(entry.byteSize);
    }
    for (const entry of manifest.variants) {
      expect(entry.constructedFrom).toBeTruthy();
      expect(entry.purpose).toBeTruthy();
    }
  });
});
