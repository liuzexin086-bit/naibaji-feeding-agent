import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ImportError, ImportOwnerMappingMismatchError } from "../../src/import/contracts.js";
import { importLegacyJson } from "../../src/import/importer.js";
import { restoreDatabaseFromBackup } from "../../src/import/sqlite-adapters.js";
import { OwnerMappingError } from "../../src/import/owner-mapping.js";
import { SourceReadError } from "../../src/import/source-adapter.js";
import {
  createImportTestContext,
  fixturePath,
  fixtureSha256,
  loadFixtureManifest,
  rowCount,
  sha256File,
  writeOwnerMapping,
} from "./helpers.js";
import type { ImportTestContext } from "./helpers.js";

const manifest = loadFixtureManifest();
const contexts: ImportTestContext[] = [];

function context(): ImportTestContext {
  const ctx = createImportTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.cleanup();
});

function runImport(ctx: ImportTestContext, fixtureName: string, targetUserId = "fixture-user") {
  const sha = fixtureSha256(manifest, fixtureName);
  const mapping = writeOwnerMapping(ctx.dir, sha, targetUserId);
  return importLegacyJson({
    sourcePath: fixturePath(fixtureName),
    ownerMappingPath: mapping.path,
    persistence: ctx.persistence,
    now: () => "2026-08-01T00:00:00.000Z",
  });
}

describe("P2-4 legacy JSON import application service", () => {
  it("imports the real sanitized source with zero loss and COMPLETE state", () => {
    const ctx = context();
    const sourceBefore = sha256File(fixturePath("legacy-json-v1-sanitized.json"));
    const result = runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(result.replay).toBe(false);
    expect(result.state).toBe("COMPLETE");
    expect(result.backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.counters).toMatchObject({
      sourceRows: 47,
      mappedNew: 24,
      replayExisting: 0,
      exactDuplicateOccurrences: 0,
      preservedArchive: 23,
      quarantined: 0,
      silentDrops: 0,
      unaccountedRows: 0,
      unexpectedDuplicates: 0,
      targetOrphans: 0,
      sourceBytesChanged: 0,
    });
    expect(result.counters.perCollection.batches).toMatchObject({ sourceRows: 5, mappedNew: 5 });
    expect(result.counters.perCollection.dailyRecords).toMatchObject({ sourceRows: 19, mappedNew: 19 });
    expect(result.counters.perCollection.recommendations).toMatchObject({ sourceRows: 19, preservedArchive: 19 });
    expect(result.counters.perCollection.sceneStates).toMatchObject({ sourceRows: 2, preservedArchive: 2 });
    expect(result.counters.perCollection.modelRegistry).toMatchObject({ sourceRows: 2, preservedArchive: 2 });
    // target writes
    expect(rowCount(ctx.database, "batches")).toBe(5);
    expect(rowCount(ctx.database, "daily_observations")).toBe(19);
    expect(rowCount(ctx.database, "import_manifests")).toBe(1);
    expect(rowCount(ctx.database, "import_record_traces")).toBe(47);
    expect(rowCount(ctx.database, "import_quarantine")).toBe(0);
    // source immutability
    expect(sha256File(fixturePath("legacy-json-v1-sanitized.json"))).toBe(sourceBefore);
    // integrity
    expect(ctx.persistence.integrity()).toEqual({ integrity: "ok", foreignKeyViolations: 0 });
    const manifestRow = ctx.persistence.findManifestBySource("json-database-v1", result.targetUserId === "" ? "" : fixtureSha256(manifest, "legacy-json-v1-sanitized.json"));
    expect(manifestRow).not.toBeNull();
    expect(manifestRow?.runState).toBe("COMPLETE");
  });

  it("replays the same source and owner mapping with zero new records", () => {
    const ctx = context();
    const first = runImport(ctx, "legacy-json-v1-sanitized.json");
    const digestBefore = ctx.persistence.querySourceDigest("json-database-v1", fixtureSha256(manifest, "legacy-json-v1-sanitized.json"));
    const replay = runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(replay.replay).toBe(true);
    expect(replay.state).toBe("COMPLETE");
    expect(rowCount(ctx.database, "batches")).toBe(5);
    expect(rowCount(ctx.database, "daily_observations")).toBe(19);
    expect(rowCount(ctx.database, "import_manifests")).toBe(1);
    expect(rowCount(ctx.database, "import_record_traces")).toBe(47);
    expect(ctx.persistence.querySourceDigest("json-database-v1", fixtureSha256(manifest, "legacy-json-v1-sanitized.json"))).toBe(digestBefore);
    expect(replay.payloadDigest).toBe(first.payloadDigest);
  });

  it("fails closed when the same source is imported with a different owner mapping", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json", "fixture-other-user")).toThrow(
      ImportOwnerMappingMismatchError,
    );
    expect(rowCount(ctx.database, "import_manifests")).toBe(1);
    expect(rowCount(ctx.database, "batches")).toBe(5);
  });

  it("rejects a mapping bound to a different source and a missing target user", () => {
    const ctx = context();
    const sha = fixtureSha256(manifest, "legacy-json-v1-sanitized.json");
    const badMapping = writeOwnerMapping(ctx.dir, "0".repeat(64));
    expect(() =>
      importLegacyJson({
        sourcePath: fixturePath("legacy-json-v1-sanitized.json"),
        ownerMappingPath: badMapping.path,
        persistence: ctx.persistence,
      }),
    ).toThrow(/mapping-source-mismatch/);
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json", "missing-user")).toThrow(/target-user-missing/);
    expect(rowCount(ctx.database, "import_manifests")).toBe(0);
    expect(rowCount(ctx.database, "batches")).toBe(0);
  });

  it("counts exact duplicate occurrences once and traces every occurrence", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-duplicates.json");
    expect(result.state).toBe("COMPLETE");
    expect(result.counters.perCollection.dailyRecords).toMatchObject({
      sourceRows: 20,
      mappedNew: 19,
      exactDuplicateOccurrences: 1,
    });
    expect(result.counters.perCollection.recommendations).toMatchObject({
      sourceRows: 20,
      preservedArchive: 19,
      exactDuplicateOccurrences: 1,
    });
    expect(rowCount(ctx.database, "daily_observations")).toBe(19);
    expect(rowCount(ctx.database, "import_record_traces")).toBe(49);
  });

  it("quarantines same-ID different-content conflicts before target mutation", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-conflict.json");
    expect(result.state).toBe("PRESERVED_WITH_QUARANTINE");
    expect(result.counters.perCollection.dailyRecords).toMatchObject({
      sourceRows: 20,
      mappedNew: 18,
      quarantined: 2,
    });
    expect(result.counters.quarantined).toBe(2);
    const quarantine = ctx.persistence.listQuarantine();
    // one quarantine row per conflicted identity; both occurrences are traced
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.reasonCode).toBe("duplicate-conflict");
    const conflictTraces = ctx.database
      .prepare("SELECT COUNT(*) AS n FROM import_record_traces WHERE reason_code = 'duplicate-conflict'")
      .get() as { n: number };
    expect(Number(conflictTraces.n)).toBe(2);
    // the conflicted identity must not exist as a target row
    const conflictedId = (JSON.parse(readFileSync(fixturePath("legacy-json-v1-conflict.json"), "utf8")) as { dailyRecords: Array<{ id: string }> }).dailyRecords[0].id;
    expect(ctx.database.prepare("SELECT 1 AS n FROM daily_observations WHERE id = ?").get(conflictedId)).toBeUndefined();
  });

  it("gives rows without a provable source ID a stable source-bound quarantine identity", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-missing-ids.json");
    expect(result.state).toBe("PRESERVED_WITH_QUARANTINE");
    expect(result.counters.quarantined).toBe(2);
    expect(result.counters.perCollection.dailyRecords).toMatchObject({
      sourceRows: 19,
      mappedNew: 18,
      quarantined: 1,
    });
    expect(result.counters.perCollection.recommendations).toMatchObject({
      sourceRows: 19,
      preservedArchive: 18,
      quarantined: 1,
    });
    const quarantine = ctx.persistence.listQuarantine();
    expect(quarantine).toHaveLength(2);
    expect(quarantine.every((row) => row.reasonCode === "missing-unsupported-id")).toBe(true);
    // quarantine identity is source-bound and deterministic
    const identity = quarantine[0]?.sourceRecordIdentity as string;
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(ctx.persistence.findQuarantineBySourceRecordIdentity(
      "json-database-v1",
      fixtureSha256(manifest, "legacy-json-v1-missing-ids.json"),
      "dailyRecords",
      identity,
    )).not.toBeNull();
  });

  it("persists quarantine across close and reopen", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-missing-ids.json");
    const dbPath = ctx.dbPath;
    ctx.database.close();
    const reopened = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = Number(reopened.prepare("SELECT COUNT(*) AS n FROM import_quarantine").get()?.n ?? 0);
      expect(count).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("quarantines child records whose parent is missing (no target orphans)", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-orphan.json");
    expect(result.state).toBe("PRESERVED_WITH_QUARANTINE");
    expect(result.counters.perCollection.dailyRecords).toMatchObject({
      sourceRows: 20,
      mappedNew: 19,
      quarantined: 1,
    });
    const quarantine = ctx.persistence.listQuarantine();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.reasonCode).toBe("missing-parent");
    expect(quarantine[0]?.parentSourceIdentity).toBe("fixture-orphan-batch");
    expect(result.counters.targetOrphans).toBe(0);
  });

  it("keeps null, omission, explicit zero, and empty collections distinct", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-invalid-observations.json");
    expect(result.state).toBe("PRESERVED_WITH_QUARANTINE");
    expect(result.counters.perCollection.batches).toMatchObject({ sourceRows: 1, mappedNew: 1 });
    expect(result.counters.perCollection.dailyRecords).toMatchObject({
      sourceRows: 3,
      mappedNew: 2,
      quarantined: 1,
    });
    expect(result.counters.perCollection.weighSamples).toMatchObject({ sourceRows: 0 });
    const quarantine = ctx.persistence.listQuarantine();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.reasonCode).toBe("ambiguous-omission-null-zero");
    // raw payload preserved losslessly in the quarantine record
    const raw = JSON.parse(quarantine[0]?.rawPayloadJson as string) as { diarrheaMild: unknown };
    expect(raw.diarrheaMild).toBeNull();
    // omitted and explicit-zero rows mapped with their raw payloads intact
    const omitted = ctx.database.prepare("SELECT data_json FROM daily_observations WHERE id = ?").get("fixture-id-9103") as { data_json: string } | undefined;
    expect(omitted).toBeDefined();
    expect((JSON.parse(omitted.data_json) as Record<string, unknown>).diarrheaMild).toBeUndefined();
    const zero = ctx.database.prepare("SELECT data_json FROM daily_observations WHERE id = ?").get("fixture-id-9102") as { data_json: string } | undefined;
    expect((JSON.parse(zero?.data_json ?? "{}") as Record<string, unknown>).diarrheaMild).toBe(0);
  });

  it("fails closed on an unsupported schema with zero destination writes", () => {
    const ctx = context();
    expect(() => runImport(ctx, "legacy-json-v1-unsupported.json")).toThrow(/unsupported-schema/);
    expect(rowCount(ctx.database, "import_manifests")).toBe(0);
    expect(rowCount(ctx.database, "batches")).toBe(0);
    expect(rowCount(ctx.database, "import_record_traces")).toBe(0);
  });

  it("fails closed on malformed JSON (duplicate keys) with zero writes", () => {
    const ctx = context();
    const path = join(ctx.dir, "malformed.json");
    writeFileSync(path, '{"meta":{"schemaVersion":1},"batches":[{"id":"a","id":"b"}],"dailyRecords":[],"weighSamples":[],"recommendations":[],"approvals":[],"executions":[],"sceneStates":[],"modelRegistry":[],"auditLogs":[]}');
    const mapping = writeOwnerMapping(ctx.dir, sha256File(path));
    expect(() =>
      importLegacyJson({
        sourcePath: path,
        ownerMappingPath: mapping.path,
        persistence: ctx.persistence,
      }),
    ).toThrow(SourceReadError);
    expect(rowCount(ctx.database, "import_manifests")).toBe(0);
    expect(rowCount(ctx.database, "batches")).toBe(0);
  });

  it("rolls back on target collision and restores the prior destination state", () => {
    const ctx = context();
    // pre-insert a batch with the same id as the first source batch but a
    // different idempotency key, so the collision surfaces at the PK
    const parsed = JSON.parse(readFileSync(fixturePath("legacy-json-v1-sanitized.json"), "utf8")) as { batches: Array<{ id: string }> };
    const collidingId = parsed.batches[0]?.id as string;
    ctx.database.prepare(
      "INSERT INTO batches (user_id, id, revision, current_day, status, data_json, idempotency_key, created_at, updated_at) VALUES ('fixture-user', ?, 0, 0, 'active', '{}', 'pre-existing', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
    ).run(collidingId);
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-collision/);
    // the transaction rolled back: no import artifacts, no new rows
    expect(rowCount(ctx.database, "import_manifests")).toBe(0);
    expect(rowCount(ctx.database, "import_record_traces")).toBe(0);
    expect(rowCount(ctx.database, "batches")).toBe(1);
    expect(rowCount(ctx.database, "daily_observations")).toBe(0);
  });

  it("restores the destination from the pre-import backup", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(rowCount(ctx.database, "batches")).toBe(5);
    ctx.database.close();
    restoreDatabaseFromBackup(ctx.dbPath, result.backup.restoreLocation);
    const restored = new DatabaseSync(ctx.dbPath);
    try {
      expect(rowCount(restored, "batches")).toBe(0);
      expect(rowCount(restored, "daily_observations")).toBe(0);
      expect(rowCount(restored, "import_manifests")).toBe(0);
      expect(String(restored.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "")).toBe("ok");
    } finally {
      restored.close();
    }
  });

  it("uses the committed owner-mapping manifest for the base source", () => {
    const ctx = context();
    const good = manifest.ownerMappings.find((entry) => entry.fixture === "owner-mapping-good.json");
    expect(good).toBeDefined();
    const result = importLegacyJson({
      sourcePath: fixturePath("legacy-json-v1-sanitized.json"),
      ownerMappingPath: fixturePath("owner-mapping-good.json"),
      persistence: ctx.persistence,
      now: () => "2026-08-01T00:00:00.000Z",
    });
    expect(result.state).toBe("COMPLETE");
    expect(result.ownerMappingSha256).toBe(good?.sha256);
    expect(result.targetUserId).toBe("fixture-user");
  });
});
