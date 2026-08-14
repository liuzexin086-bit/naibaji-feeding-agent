import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ImportError, ImportOwnerMappingMismatchError } from "../../src/import/contracts.js";
import { importLegacyJson } from "../../src/import/importer.js";
import {
  computeDestinationDigest,
  restoreDatabaseFromBackup,
} from "../../src/import/sqlite-adapters.js";
import { OwnerMappingError } from "../../src/import/owner-mapping.js";
import { SourceReadError } from "../../src/import/source-adapter.js";
import {
  quarantineIdentity,
  rawDuplicateQuarantineIdentity,
  rawRowCanonicalSha256,
  recordIdentity,
} from "../../src/import/identity.js";
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

// full frozen ReplayDigestProjection facts, exactly as the importer binds them
function factsFromManifest(ctx: ImportTestContext, fixtureName: string): import("../../src/import/contracts.js").ManifestDigestFacts {
  const sha = fixtureSha256(manifest, fixtureName);
  const row = ctx.persistence.findManifestBySource("json-database-v1", sha);
  if (!row) throw new Error("no manifest row for " + fixtureName);
  return {
    sourceKind: row.sourceKind,
    sourceSha256: row.sourceSha256,
    sourceByteLength: row.sourceByteLength,
    sourceSchemaVersion: row.sourceSchemaVersion,
    originalFilenameOrExportLabel: row.originalFilenameOrExportLabel,
    capturedAt: row.capturedAt,
    sanitizationOrOriginRecord: row.sanitizationOrOriginRecord,
    ownerMappingSha256: row.ownerMappingSha256,
    targetUserId: row.targetUserId,
    importerContractVersion: row.importerContractVersion,
    runState: row.runState,
    countersJson: row.countersJson,
    unknownTopLevelKeysJson: row.unknownTopLevelKeysJson,
    backupSha256: row.backupSha256 ?? "",
    restoreLocation: row.restoreLocation ?? "",
  };
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
    const facts = factsFromManifest(ctx, "legacy-json-v1-sanitized.json");
    const digestBefore = ctx.persistence.querySourceDigest(
      "json-database-v1",
      fixtureSha256(manifest, "legacy-json-v1-sanitized.json"),
      "fixture-user",
      facts,
    );
    const replay = runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(replay.replay).toBe(true);
    expect(replay.state).toBe("COMPLETE");
    expect(rowCount(ctx.database, "batches")).toBe(5);
    expect(rowCount(ctx.database, "daily_observations")).toBe(19);
    expect(rowCount(ctx.database, "import_manifests")).toBe(1);
    expect(rowCount(ctx.database, "import_record_traces")).toBe(47);
    expect(
      ctx.persistence.querySourceDigest(
        "json-database-v1",
        fixtureSha256(manifest, "legacy-json-v1-sanitized.json"),
        "fixture-user",
        facts,
      ),
    ).toBe(digestBefore);
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

  it("quarantines a row with duplicate keys instead of failing the whole source", () => {
    const ctx = context();
    const path = join(ctx.dir, "duplicate-key-row.json");
    writeFileSync(path, '{"meta":{"schemaVersion":1},"batches":[{"id":"a","id":"b","status":"active","currentDayIndex":0,"createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z"}],"dailyRecords":[],"weighSamples":[],"recommendations":[],"approvals":[],"executions":[],"sceneStates":[],"modelRegistry":[],"auditLogs":[]}');
    const mapping = writeOwnerMapping(ctx.dir, sha256File(path));
    const result = importLegacyJson({
      sourcePath: path,
      ownerMappingPath: mapping.path,
      persistence: ctx.persistence,
      now: () => "2026-08-01T00:00:00.000Z",
    });
    expect(result.state).toBe("PRESERVED_WITH_QUARANTINE");
    expect(result.counters.perCollection.batches).toMatchObject({
      sourceRows: 1,
      mappedNew: 0,
      quarantined: 1,
    });
    expect(rowCount(ctx.database, "import_quarantine")).toBe(1);
    const quarantine = ctx.persistence.listQuarantine();
    expect(quarantine[0]?.reasonCode).toBe("duplicate-key");
    // the quarantined row's field dispositions are recorded (contract 10)
    const fieldPaths = JSON.parse(quarantine[0]?.fieldPathsJson ?? "[]") as Array<{
      path: string;
      disposition: string;
    }>;
    expect(fieldPaths.length).toBeGreaterThan(0);
    expect(fieldPaths.every((entry) => entry.disposition === "quarantined")).toBe(true);
    // LOSS LESS raw evidence: the quarantine payload is the ORIGINAL source
    // row slice including BOTH duplicate occurrences, not a last-wins parse
    const rawPayload = quarantine[0]?.rawPayloadJson as string;
    expect(rawPayload).toContain('"id":"a"');
    expect(rawPayload).toContain('"id":"b"');
    expect(rawPayload).toContain('"status":"active"');
    expect(quarantine[0]?.rawPayloadSha256).toBe(
      createHash("sha256").update(rawPayload, "utf8").digest("hex"),
    );
    // contract 5.2 rule 2: the duplicate key IS the id field, so the
    // identity MUST be the raw-slice-bound quarantine identity over the
    // ORIGINAL raw slice SHA - never a CJSON of the last-wins parse
    const expectedIdentity = rawDuplicateQuarantineIdentity({
      sourceKind: "json-database-v1",
      sourceSha256: sha256File(path),
      collection: "batches",
      originalRawRowSha256: quarantine[0]?.rawPayloadSha256 as string,
      sourceOrdinal: 0,
    });
    expect(quarantine[0]?.sourceRecordIdentity).toBe(expectedIdentity);
    // and the identity must NOT be derived from the last-wins row
    const lastWinsIdentity = quarantineIdentity({
      sourceKind: "json-database-v1",
      sourceSha256: sha256File(path),
      collection: "batches",
      rawRowCanonicalSha256: rawRowCanonicalSha256({ id: "b", status: "active", currentDayIndex: 0, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }),
      sourceOrdinal: 0,
    });
    expect(quarantine[0]?.sourceRecordIdentity).not.toBe(lastWinsIdentity);
    expect(rowCount(ctx.database, "batches")).toBe(0);
  });

  it("keeps record_identity for a duplicate-key row whose source id stays provable (contract 5.2 rule 1)", () => {
    const ctx = context();
    const path = join(ctx.dir, "duplicate-key-rule1.json");
    writeFileSync(path, '{"meta":{"schemaVersion":1},"batches":[{"id":"stable-id","status":"a","status":"b","currentDayIndex":0,"createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z"}],"dailyRecords":[],"weighSamples":[],"recommendations":[],"approvals":[],"executions":[],"sceneStates":[],"modelRegistry":[],"auditLogs":[]}');
    const mapping = writeOwnerMapping(ctx.dir, sha256File(path));
    const result = importLegacyJson({
      sourcePath: path,
      ownerMappingPath: mapping.path,
      persistence: ctx.persistence,
      now: () => "2026-08-01T00:00:00.000Z",
    });
    expect(result.state).toBe("PRESERVED_WITH_QUARANTINE");
    const quarantine = ctx.persistence.listQuarantine();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.reasonCode).toBe("duplicate-key");
    // rule 1: identity is the NORMAL record_identity for the provable id
    const expectedIdentity = recordIdentity({
      sourceKind: "json-database-v1",
      sourceSha256: sha256File(path),
      collection: "batches",
      sourceRecordId: "stable-id",
    });
    expect(quarantine[0]?.sourceRecordIdentity).toBe(expectedIdentity);
    // raw evidence still lossless (both status occurrences)
    expect(quarantine[0]?.rawPayloadJson).toContain('"status":"a"');
    expect(quarantine[0]?.rawPayloadJson).toContain('"status":"b"');
    expect(rowCount(ctx.database, "batches")).toBe(0);
  });

  it("fails closed on envelope-level duplicate keys with zero writes", () => {
    const ctx = context();
    const path = join(ctx.dir, "malformed.json");
    writeFileSync(path, '{"meta":{"schemaVersion":1},"batches":[],"dailyRecords":[],"weighSamples":[],"recommendations":[],"approvals":[],"executions":[],"sceneStates":[],"modelRegistry":[],"auditLogs":[],"batches":[]}');
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

  it("restores the destination and produces the frozen restore receipt", () => {
    const ctx = context();
    const preImportDigest = computeDestinationDigest(ctx.dbPath);
    const result = runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(rowCount(ctx.database, "batches")).toBe(5);
    expect(computeDestinationDigest(ctx.dbPath)).not.toBe(preImportDigest);
    ctx.database.close();
    // restore consumes ONLY the evidence sealed by the backup authority
    const receipt = restoreDatabaseFromBackup(ctx.dbPath, result.backup.restoreLocation, result.backup);
    // frozen rollback receipt: backup identity, sealed pre-import proof,
    // post-restore content digest, integrity and FK result, restore log
    expect(receipt.backupSha256).toBe(result.backup.sha256);
    expect(receipt.preImportContentDigest).toBe(result.backup.preImportContentDigest);
    expect(receipt.preImportCommit).toBe(result.backup.preImportCommit);
    expect(receipt.sourceSha256).toBe(result.backup.sourceSha256);
    expect(receipt.ownerMappingSha256).toBe(result.backup.ownerMappingSha256);
    expect(receipt.digestMatch).toBe(true);
    expect(receipt.postRestoreDigest).toBe(preImportDigest);
    expect(receipt.postRestoreDigest).toBe(result.backup.preImportContentDigest);
    expect(receipt.integrity).toBe("ok");
    expect(receipt.foreignKeyViolations).toBe(0);
    expect(receipt.restoreSource).toBe(result.backup.restoreLocation);
    expect(receipt.restoreTarget).toBe(ctx.dbPath);
    const restored = new DatabaseSync(ctx.dbPath);
    try {
      expect(rowCount(restored, "batches")).toBe(0);
      expect(rowCount(restored, "daily_observations")).toBe(0);
      expect(rowCount(restored, "import_manifests")).toBe(0);
      expect(rowCount(restored, "import_backup_evidence")).toBe(0);
    } finally {
      restored.close();
    }
    // a backup tamper aborts the restore before any file mutation
    const tamperedBackup = join(ctx.dir, "tampered-backup.db");
    writeFileSync(tamperedBackup, "tampered");
    expect(() =>
      restoreDatabaseFromBackup(ctx.dbPath, tamperedBackup, result.backup),
    ).toThrow(/backup SHA-256 mismatch/);
  });

  it("fails closed when the post-restore state does not match the sealed pre-import proof", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-sanitized.json");
    ctx.database.close();
    // valid backup file with the CORRECT sha256 but a forged sealed digest:
    // the restore must fail closed instead of emitting a mismatch receipt
    const forged = {
      ...result.backup,
      preImportContentDigest: "0".repeat(64),
    };
    expect(() =>
      restoreDatabaseFromBackup(ctx.dbPath, result.backup.restoreLocation, forged),
    ).toThrow(/restore failed closed/);
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

  it("scopes the replay digest to the accepted target user", () => {
    const ctx = context();
    const sha = fixtureSha256(manifest, "legacy-json-v1-sanitized.json");
    const result = runImport(ctx, "legacy-json-v1-sanitized.json");
    // a second tenant holds a row with the same business id but different content
    ctx.database.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('tenant-b', 'tenant-b@example.invalid', 'operator', '2026-08-01T00:00:00.000Z')").run();
    const parsed = JSON.parse(readFileSync(fixturePath("legacy-json-v1-sanitized.json"), "utf8")) as { batches: Array<{ id: string }> };
    const firstBatchId = parsed.batches[0]?.id as string;
    ctx.database.prepare(
      "INSERT INTO batches (user_id, id, revision, current_day, status, data_json, idempotency_key, created_at, updated_at) VALUES ('tenant-b', ?, 0, 0, 'active', '{\"tenant\":\"b\"}', 'tenant-b-key', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
    ).run(firstBatchId);
    // replay must not see tenant-b's row: the digest is unchanged and replay passes
    const replay = runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(replay.replay).toBe(true);
    const facts = factsFromManifest(ctx, "legacy-json-v1-sanitized.json");
    expect(ctx.persistence.querySourceDigest("json-database-v1", sha, "fixture-user", facts)).toBe(
      result.payloadDigest,
    );
    // the same source under tenant-b's scope fails closed: the trace targets
    // belong to fixture-user and must not be resolvable as tenant-b's rows
    expect(() =>
      ctx.persistence.querySourceDigest("json-database-v1", sha, "tenant-b", facts),
    ).toThrow(/missing target row/);
  });

  it("fails replay with target-drift when preserved_raw trace payload is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    ctx.database.prepare(
      "UPDATE import_record_traces SET raw_payload_json = '{\"tampered\":true}' WHERE disposition = 'preserved_raw'",
    ).run();
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-drift/);
  });

  it("records unknown top-level keys in the import manifest", () => {
    const ctx = context();
    const path = join(ctx.dir, "with-unknown-keys.json");
    const base = readFileSync(fixturePath("legacy-json-v1-sanitized.json"), "utf8");
    const withUnknown = base.slice(0, base.length - 2) + ',"futureExtension":{"a":1}}' + "\n";
    writeFileSync(path, withUnknown);
    const mapping = writeOwnerMapping(ctx.dir, sha256File(path));
    const result = importLegacyJson({
      sourcePath: path,
      ownerMappingPath: mapping.path,
      persistence: ctx.persistence,
      now: () => "2026-08-01T00:00:00.000Z",
    });
    expect(result.state).toBe("COMPLETE");
    const manifestRow = ctx.persistence.findManifestBySource("json-database-v1", sha256File(path));
    const unknownEvidence = JSON.parse(manifestRow?.unknownTopLevelKeysJson ?? "[]") as Array<{
      key: string;
      rawText: string;
      rawSha256: string;
      value: { a: number };
    }>;
    expect(unknownEvidence).toHaveLength(1);
    expect(unknownEvidence[0]?.key).toBe("futureExtension");
    // the unknown top-level VALUE and its original text are preserved losslessly
    expect(unknownEvidence[0]?.value).toEqual({ a: 1 });
    expect(unknownEvidence[0]?.rawText).toBe('{"a":1}');
    expect(unknownEvidence[0]?.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records field-level dispositions for mapped and preserved rows", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    const mappedTrace = ctx.database.prepare(
      "SELECT field_paths_json FROM import_record_traces WHERE disposition = 'mapped' AND collection = 'dailyRecords' LIMIT 1",
    ).get() as { field_paths_json: string };
    const mappedFields = JSON.parse(mappedTrace.field_paths_json) as Array<{ path: string; disposition: string }>;
    expect(mappedFields.length).toBeGreaterThan(0);
    expect(mappedFields.every((entry) => entry.disposition === "mapped")).toBe(true);
    expect(mappedFields[0]?.path).toMatch(/^\$\["dailyRecords"\]\[\d+\]\["/);
    const preservedTrace = ctx.database.prepare(
      "SELECT field_paths_json FROM import_record_traces WHERE disposition = 'preserved_raw' LIMIT 1",
    ).get() as { field_paths_json: string };
    const preservedFields = JSON.parse(preservedTrace.field_paths_json) as Array<{ disposition: string }>;
    expect(preservedFields.length).toBeGreaterThan(0);
    expect(preservedFields.every((entry) => entry.disposition === "preserved_raw")).toBe(true);
    // field-specific quarantine: only the offending field is quarantined
    runImport(ctx, "legacy-json-v1-invalid-observations.json");
    const quarantine = ctx.persistence.listQuarantine();
    const fieldSpecific = quarantine.find((row) => row.reasonCode === "ambiguous-omission-null-zero");
    const fieldPaths = JSON.parse(fieldSpecific?.fieldPathsJson ?? "[]") as Array<{
      path: string;
      disposition: string;
      reasonCode?: string;
    }>;
    const diarrheaField = fieldPaths.find((entry) => entry.path.includes("diarrheaMild"));
    expect(diarrheaField).toMatchObject({
      disposition: "quarantined",
      reasonCode: "ambiguous-omission-null-zero",
    });
    const otherFields = fieldPaths.filter((entry) => !entry.path.includes("diarrheaMild"));
    expect(otherFields.length).toBeGreaterThan(0);
    expect(otherFields.every((entry) => entry.disposition === "preserved_raw")).toBe(true);
  });

  it("persists full backup identity evidence with the run", () => {
    const ctx = context();
    const result = runImport(ctx, "legacy-json-v1-sanitized.json");
    expect(result.backup.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.backup.migrationLedgerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.backup.applicationVersion).toBe("0.1.0");
    expect(result.backup.integrity).toBe("ok");
    expect(result.backup.foreignKeyViolations).toBe(0);
    const persisted = ctx.persistence.findBackupEvidenceByRunId(result.runId);
    expect(persisted).not.toBeNull();
    expect(persisted?.schemaDigest).toBe(result.backup.schemaDigest);
    expect(persisted?.migrationLedgerSha256).toBe(result.backup.migrationLedgerSha256);
    // sealed pre-import proof (contract 11, P2-4-F07.1)
    expect(persisted?.preImportContentDigest).toBe(result.backup.preImportContentDigest);
    expect(persisted?.preImportContentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.preImportCommit).toBe(result.backup.preImportCommit);
    expect(persisted?.sourceSha256).toBe(result.backup.sourceSha256);
    expect(persisted?.sourceSha256).toBe(fixtureSha256(manifest, "legacy-json-v1-sanitized.json"));
    expect(persisted?.ownerMappingSha256).toBe(result.backup.ownerMappingSha256);
    // the sealed pre-import digest equals the digest of the backup file itself
    expect(computeDestinationDigest(persisted?.restoreLocation as string)).toBe(result.backup.preImportContentDigest);
    // the backup itself opens and passes integrity/FK checks
    const backupDb = new DatabaseSync(persisted?.restoreLocation as string, { readOnly: true });
    try {
      expect(backupDb.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      expect(backupDb.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      backupDb.close();
    }
  });

  it("rolls back automatically when post-import integrity acceptance fails", () => {
    const ctx = context();
    const failing = Object.create(ctx.persistence) as typeof ctx.persistence;
    failing.integrity = () => ({ integrity: "ok", foreignKeyViolations: 1 });
    const sha = fixtureSha256(manifest, "legacy-json-v1-sanitized.json");
    const mapping = writeOwnerMapping(ctx.dir, sha);
    expect(() =>
      importLegacyJson({
        sourcePath: fixturePath("legacy-json-v1-sanitized.json"),
        ownerMappingPath: mapping.path,
        persistence: failing,
        now: () => "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow(/post-import integrity failure/);
    // the transaction rolled back: the destination is unchanged
    expect(rowCount(ctx.database, "import_manifests")).toBe(0);
    expect(rowCount(ctx.database, "import_record_traces")).toBe(0);
    expect(rowCount(ctx.database, "import_backup_evidence")).toBe(0);
    expect(rowCount(ctx.database, "batches")).toBe(0);
    expect(rowCount(ctx.database, "daily_observations")).toBe(0);
  });

  it("fails replay when trace field_paths_json is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    ctx.database.prepare(
      "UPDATE import_record_traces SET field_paths_json = '[]' WHERE disposition = 'mapped'",
    ).run();
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-drift/);
  });

  it("fails replay when a quarantine reason_code is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-missing-ids.json");
    ctx.database.prepare(
      "UPDATE import_quarantine SET reason_code = 'tampered' WHERE reason_code = 'missing-unsupported-id'",
    ).run();
    expect(() => runImport(ctx, "legacy-json-v1-missing-ids.json")).toThrow(/target-drift/);
  });

  it("fails replay when manifest counters evidence is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    const manifestRow = ctx.persistence.findManifestBySource(
      "json-database-v1",
      fixtureSha256(manifest, "legacy-json-v1-sanitized.json"),
    );
    expect(manifestRow).not.toBeNull();
    ctx.database.prepare(
      "UPDATE import_manifests SET counters_json = '{\"tampered\":true}' WHERE id = ?",
    ).run(manifestRow?.id);
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-drift/);
  });

  it("fails replay with target-drift when an authoritative batches column is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    ctx.database.prepare(
      "UPDATE batches SET status = 'tampered' WHERE user_id = 'fixture-user'",
    ).run();
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-drift/);
  });

  it("fails replay with target-drift when an authoritative observation column is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    // swap batch_id to another EXISTING batch so the FK stays satisfied and
    // the authoritative column drift must surface in the replay digest
    ctx.database.prepare(
      "UPDATE daily_observations SET batch_id = (" +
      " SELECT id FROM batches WHERE user_id = 'fixture-user' AND id != (" +
      "   SELECT batch_id FROM daily_observations WHERE user_id = 'fixture-user' LIMIT 1" +
      " ) LIMIT 1)",
    ).run();
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-drift/);
    // and a plain authoritative timestamp mutation
    ctx.database.prepare(
      "UPDATE daily_observations SET observed_at = '2099-01-01T00:00:00.000Z'",
    ).run();
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-drift/);
  });

  it("fails replay with target-drift when quarantine parent provenance is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-orphan.json");
    ctx.database.prepare(
      "UPDATE import_quarantine SET parent_source_identity = 'tampered-parent'",
    ).run();
    expect(() => runImport(ctx, "legacy-json-v1-orphan.json")).toThrow(/target-drift/);
  });

  it("fails replay with target-drift when manifest contract version is mutated", () => {
    const ctx = context();
    runImport(ctx, "legacy-json-v1-sanitized.json");
    const manifestRow = ctx.persistence.findManifestBySource(
      "json-database-v1",
      fixtureSha256(manifest, "legacy-json-v1-sanitized.json"),
    );
    expect(manifestRow).not.toBeNull();
    ctx.database.prepare(
      "UPDATE import_manifests SET importer_contract_version = 'tampered' WHERE id = ?",
    ).run(manifestRow?.id);
    expect(() => runImport(ctx, "legacy-json-v1-sanitized.json")).toThrow(/target-drift/);
  });
});
