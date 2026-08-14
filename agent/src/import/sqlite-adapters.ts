/**
 * P2-4 SQLite adapters for the import persistence port (contract 13).
 *
 * This module executes zero schema DDL: every table it reads or writes is
 * created only by forward migration v14 owned by packages/persistence/migrations.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BackupEvidence,
  ImportManifestRow,
  ImportPersistencePort,
  QuarantineRow,
  RunState,
  TargetBatchInput,
  TargetObservationInput,
  TargetRowDigestEntry,
  TraceRow,
} from "../import/contracts.js";
import { ImportError } from "../import/contracts.js";

type Row = Record<string, unknown>;

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runStateOf(value: unknown): RunState {
  const state = String(value);
  if (
    state !== "COMPLETE" &&
    state !== "PRESERVED_WITH_QUARANTINE" &&
    state !== "INCOMPLETE" &&
    state !== "FAILED_ROLLED_BACK"
  ) {
    throw new Error("invalid import_manifests.run_state " + state);
  }
  return state;
}

function manifestFromRow(row: Row): ImportManifestRow {
  return {
    id: String(row.id),
    sourceKind: String(row.source_kind),
    sourceSha256: String(row.source_sha256),
    sourceByteLength: Number(row.source_byte_length),
    sourceSchemaVersion: String(row.source_schema_version),
    originalFilenameOrExportLabel: row.original_filename_or_export_label == null
      ? null
      : String(row.original_filename_or_export_label),
    capturedAt: row.captured_at == null ? null : String(row.captured_at),
    sanitizationOrOriginRecord: row.sanitization_or_origin_record == null
      ? null
      : String(row.sanitization_or_origin_record),
    ownerMappingSha256: String(row.owner_mapping_sha256),
    targetUserId: String(row.target_user_id),
    importerContractVersion: String(row.importer_contract_version),
    runState: runStateOf(row.run_state),
    countersJson: String(row.counters_json),
    payloadDigest: String(row.payload_digest),
    backupSha256: row.backup_sha256 == null ? null : String(row.backup_sha256),
    restoreLocation: row.restore_location == null ? null : String(row.restore_location),
    createdAt: String(row.created_at),
  };
}

function quarantineFromRow(row: Row): QuarantineRow {
  return {
    id: Number(row.id),
    importRunId: String(row.import_run_id),
    sourceKind: String(row.source_kind),
    sourceSha256: String(row.source_sha256),
    collection: String(row.collection),
    sourceRecordIdentity: String(row.source_record_identity),
    sourceOrdinal: Number(row.source_ordinal),
    rawPayloadBytes: Number(row.raw_payload_bytes),
    rawPayloadSha256: String(row.raw_payload_sha256),
    rawPayloadJson: String(row.raw_payload_json),
    reasonCode: String(row.reason_code),
    fieldPathsJson: row.field_paths_json == null ? null : String(row.field_paths_json),
    parentSourceIdentity: row.parent_source_identity == null
      ? null
      : String(row.parent_source_identity),
    ownerMappingSha256: String(row.owner_mapping_sha256),
    createdAt: String(row.created_at),
    resolutionStatus: String(row.resolution_status) === "resolved" ? "resolved" : "unresolved",
  };
}

/**
 * Content-bearing digest of everything a source produced in the destination:
 * mapped target rows plus quarantine records. Used to prove that replay
 * produces identical target/raw/quarantine content (contract 8, 12).
 */
function computeSourceDigest(
  statements: Record<string, ReturnType<DatabaseSync["prepare"]>>,
  sourceKind: string,
  sourceSha256: string,
): string {
  const targets: TargetRowDigestEntry[] = [];
  for (const row of statements.traceTargets.all(sourceKind, sourceSha256) as Row[]) {
    const table = String(row.target_table);
    const id = String(row.target_id);
    const content = table === "batches"
      ? (statements.batchById.get(id) as Row | undefined)
      : (statements.observationById.get(id) as Row | undefined);
    if (content === undefined) {
      throw new ImportError("target-drift: missing target row " + table + " " + id);
    }
    targets.push({ table, id, dataJson: String(content.data_json) });
  }
  const quarantine = (statements.quarantineDigestRows.all(sourceKind, sourceSha256) as Row[]).map(
    (row) => ({
      collection: String(row.collection),
      identity: String(row.source_record_identity),
      rawPayloadSha256: String(row.raw_payload_sha256),
    }),
  );
  return sha256Text(JSON.stringify({ targets, quarantine }));
}

export function createImportPersistence(
  database: DatabaseSync,
  databasePath: string,
): ImportPersistencePort {
  const statements: Record<string, ReturnType<DatabaseSync["prepare"]>> = {
    findManifest: database.prepare(
      "SELECT * FROM import_manifests WHERE source_kind = ? AND source_sha256 = ?",
    ),
    insertManifest: database.prepare(
      "INSERT INTO import_manifests (" +
      " id, source_kind, source_sha256, source_byte_length, source_schema_version," +
      " original_filename_or_export_label, captured_at, sanitization_or_origin_record," +
      " owner_mapping_sha256, target_user_id, importer_contract_version, run_state," +
      " counters_json, payload_digest, backup_sha256, restore_location, created_at" +
      " ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    findUser: database.prepare("SELECT id FROM users WHERE id = ?"),
    insertTrace: database.prepare(
      "INSERT INTO import_record_traces (" +
      " import_run_id, source_kind, source_sha256, collection, record_identity," +
      " source_ordinal, disposition, target_table, target_id, raw_payload_bytes," +
      " raw_payload_sha256, raw_payload_json, reason_code, field_paths_json," +
      " parent_identity, owner_mapping_sha256, created_at" +
      " ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    findQuarantine: database.prepare(
      "SELECT * FROM import_quarantine WHERE source_kind = ? AND source_sha256 = ?" +
      " AND collection = ? AND source_record_identity = ?",
    ),
    insertQuarantine: database.prepare(
      "INSERT INTO import_quarantine (" +
      " import_run_id, source_kind, source_sha256, collection, source_record_identity," +
      " source_ordinal, raw_payload_bytes, raw_payload_sha256, raw_payload_json," +
      " reason_code, field_paths_json, parent_source_identity, owner_mapping_sha256," +
      " created_at, resolution_status" +
      " ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    listQuarantine: database.prepare(
      "SELECT * FROM import_quarantine ORDER BY source_kind, source_sha256, collection, source_ordinal LIMIT ?",
    ),
    countQuarantineUnresolved: database.prepare(
      "SELECT COUNT(*) AS n FROM import_quarantine WHERE resolution_status = 'unresolved'",
    ),
    findBatchByImportKey: database.prepare(
      "SELECT 1 AS found FROM batches WHERE user_id = ? AND idempotency_key = ?",
    ),
    findObservationByImportKey: database.prepare(
      "SELECT 1 AS found FROM daily_observations WHERE user_id = ? AND idempotency_key = ?",
    ),
    insertBatch: database.prepare(
      "INSERT INTO batches (" +
      " user_id, id, revision, current_day, status, data_json, idempotency_key," +
      " created_at, updated_at" +
      " ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertObservation: database.prepare(
      "INSERT INTO daily_observations (" +
      " user_id, id, batch_id, date_local, observed_at, batch_revision, data_json," +
      " idempotency_key, created_at" +
      " ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    traceTargets: database.prepare(
      "SELECT target_table, target_id FROM import_record_traces" +
      " WHERE source_kind = ? AND source_sha256 = ? AND target_table IS NOT NULL" +
      " ORDER BY target_table, target_id",
    ),
    quarantineDigestRows: database.prepare(
      "SELECT collection, source_record_identity, raw_payload_sha256 FROM import_quarantine" +
      " WHERE source_kind = ? AND source_sha256 = ? ORDER BY collection, source_record_identity",
    ),
    batchById: database.prepare(
      "SELECT user_id, id, revision, current_day, status, data_json FROM batches WHERE id = ?",
    ),
    observationById: database.prepare(
      "SELECT user_id, id, batch_id, date_local, observed_at, batch_revision, data_json" +
      " FROM daily_observations WHERE id = ?",
    ),
    integrityCheck: database.prepare("PRAGMA integrity_check"),
    foreignKeyCheck: database.prepare("PRAGMA foreign_key_check"),
  };

  return {
    databasePath,
    findManifestBySource(sourceKind, sourceSha256) {
      const row = statements.findManifest.get(sourceKind, sourceSha256) as Row | undefined;
      return row ? manifestFromRow(row) : null;
    },
    findUserById(userId) {
      return statements.findUser.get(userId) !== undefined;
    },
    insertManifest(row) {
      statements.insertManifest.run(
        row.id,
        row.sourceKind,
        row.sourceSha256,
        row.sourceByteLength,
        row.sourceSchemaVersion,
        row.originalFilenameOrExportLabel,
        row.capturedAt,
        row.sanitizationOrOriginRecord,
        row.ownerMappingSha256,
        row.targetUserId,
        row.importerContractVersion,
        row.runState,
        row.countersJson,
        row.payloadDigest,
        row.backupSha256,
        row.restoreLocation,
        row.createdAt,
      );
    },
    insertTrace(row) {
      statements.insertTrace.run(
        row.importRunId,
        row.sourceKind,
        row.sourceSha256,
        row.collection,
        row.recordIdentity,
        row.sourceOrdinal,
        row.disposition,
        row.targetTable,
        row.targetId,
        row.rawPayloadBytes,
        row.rawPayloadSha256,
        row.rawPayloadJson,
        row.reasonCode,
        row.fieldPathsJson,
        row.parentIdentity,
        row.ownerMappingSha256,
        row.createdAt,
      );
    },
    findQuarantineBySourceRecordIdentity(sourceKind, sourceSha256, collection, identity) {
      const row = statements.findQuarantine.get(
        sourceKind,
        sourceSha256,
        collection,
        identity,
      ) as Row | undefined;
      return row ? quarantineFromRow(row) : null;
    },
    insertQuarantine(row) {
      statements.insertQuarantine.run(
        row.importRunId,
        row.sourceKind,
        row.sourceSha256,
        row.collection,
        row.sourceRecordIdentity,
        row.sourceOrdinal,
        row.rawPayloadBytes,
        row.rawPayloadSha256,
        row.rawPayloadJson,
        row.reasonCode,
        row.fieldPathsJson,
        row.parentSourceIdentity,
        row.ownerMappingSha256,
        row.createdAt,
        row.resolutionStatus,
      );
    },
    listQuarantine(limit = 1000) {
      return (statements.listQuarantine.all(limit) as Row[]).map(quarantineFromRow);
    },
    countQuarantineUnresolved() {
      return Number(statements.countQuarantineUnresolved.get()?.n ?? 0);
    },
    findBatchByImportKey(userId, idempotencyKey) {
      return statements.findBatchByImportKey.get(userId, idempotencyKey) !== undefined;
    },
    findObservationByImportKey(userId, idempotencyKey) {
      return statements.findObservationByImportKey.get(userId, idempotencyKey) !== undefined;
    },
    insertBatch(input: TargetBatchInput) {
      try {
        statements.insertBatch.run(
          input.userId,
          input.id,
          input.revision,
          input.currentDay,
          input.status,
          input.dataJson,
          input.idempotencyKey,
          input.createdAt,
          input.updatedAt,
        );
      } catch (error) {
        throw new ImportError(
          "target-collision: batch " + input.id + ": " + (error as Error).message,
        );
      }
    },
    insertObservation(input: TargetObservationInput) {
      try {
        statements.insertObservation.run(
          input.userId,
          input.id,
          input.batchId,
          input.dateLocal,
          input.observedAt,
          input.batchRevision,
          input.dataJson,
          input.idempotencyKey,
          input.createdAt,
        );
      } catch (error) {
        throw new ImportError(
          "target-collision: observation " + input.id + ": " + (error as Error).message,
        );
      }
    },
    queryTargetRowsByImportKeys(keys) {
      const entries: TargetRowDigestEntry[] = [];
      const seen = new Set<string>();
      for (const table of ["batches", "daily_observations"]) {
        const statement = table === "batches" ? statements.batchById : statements.observationById;
        for (const key of keys) {
          if (seen.has(key)) continue;
          const row = statement.get(key) as Row | undefined;
          if (row !== undefined) {
            seen.add(key);
            entries.push({ table, id: String(row.id), dataJson: String(row.data_json) });
          }
        }
      }
      return entries.sort((a, b) => (a.table + a.id < b.table + b.id ? -1 : 1));
    },
    querySourceDigest(sourceKind, sourceSha256) {
      return computeSourceDigest(statements, sourceKind, sourceSha256);
    },
    createBackup(): BackupEvidence {
      const directory = mkdtempSync(join(tmpdir(), "naibaji-import-backup-"));
      const backupPath = join(directory, "backup.db");
      database.exec("VACUUM INTO '" + backupPath + "'");
      const check = new DatabaseSync(backupPath, { readOnly: true });
      try {
        const integrity = String(
          check.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
        );
        if (integrity !== "ok") {
          throw new ImportError("backup integrity check failed: " + integrity);
        }
      } finally {
        check.close();
      }
      return { sha256: sha256File(backupPath), restoreLocation: backupPath };
    },
    integrity() {
      const integrity = String(statements.integrityCheck.get()?.integrity_check ?? "");
      const foreignKeyViolations = (statements.foreignKeyCheck.all() as Row[]).length;
      return { integrity, foreignKeyViolations };
    },
    transaction<T>(operation: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = operation();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/**
 * Restore a database file from an import backup snapshot. The caller must
 * close the live connection first; stale WAL/SHM sidecar files are removed
 * so the restored file is authoritative.
 */
export function restoreDatabaseFromBackup(databasePath: string, backupPath: string): void {
  if (!existsSync(backupPath)) throw new ImportError("backup file missing: " + backupPath);
  copyFileSync(backupPath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = databasePath + suffix;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
}
