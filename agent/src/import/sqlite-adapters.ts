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
  ImportBackupEvidenceRow,
  ImportManifestRow,
  ImportPersistencePort,
  ManifestDigestFacts,
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
    unknownTopLevelKeysJson: row.unknown_top_level_keys_json == null
      ? null
      : String(row.unknown_top_level_keys_json),
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
  targetUserId: string,
  manifestFacts: ManifestDigestFacts,
): string {
  // tenant safety: the authority key of the target tables is (user_id, id),
  // so target rows are always read scoped to the accepted target user
  const targets: TargetRowDigestEntry[] = [];
  for (const row of statements.traceTargets.all(sourceKind, sourceSha256) as Row[]) {
    const table = String(row.target_table) as "batches" | "daily_observations";
    const id = String(row.target_id);
    const content = table === "batches"
      ? (statements.batchById.get(targetUserId, id) as Row | undefined)
      : (statements.observationById.get(targetUserId, id) as Row | undefined);
    if (content === undefined) {
      throw new ImportError(
        "target-drift: missing target row " + table + " " + id + " for user " + targetUserId,
      );
    }
    // frozen ReplayDigestProjection: bind EVERY authoritative persisted
    // column of the mapped target row, not only data_json
    if (table === "batches") {
      targets.push({
        table,
        id,
        dataJson: String(content.data_json),
        revision: Number(content.revision),
        currentDay: Number(content.current_day),
        status: String(content.status),
        batchId: null,
        dateLocal: null,
        observedAt: null,
        batchRevision: null,
        idempotencyKey: String(content.idempotency_key),
        createdAt: String(content.created_at),
        updatedAt: String(content.updated_at),
      });
    } else {
      targets.push({
        table,
        id,
        dataJson: String(content.data_json),
        revision: null,
        currentDay: null,
        status: null,
        batchId: String(content.batch_id),
        dateLocal: String(content.date_local),
        observedAt: String(content.observed_at),
        batchRevision: Number(content.batch_revision),
        idempotencyKey: String(content.idempotency_key),
        createdAt: String(content.created_at),
        updatedAt: null,
      });
    }
  }
  // complete provenance evidence: every trace record (identity, ordinal,
  // disposition, reason, parent, field paths, and content-bearing payload),
  // every quarantine record (identity, ordinal, reason, field paths,
  // parent identity, owner mapping, resolution status, payload),
  // and the complete manifest acceptance facts are bound to the digest
  const traces = (statements.traceDigestRows.all(sourceKind, sourceSha256) as Row[]).map((row) => ({
    collection: String(row.collection),
    identity: String(row.record_identity),
    ordinal: Number(row.source_ordinal),
    disposition: String(row.disposition),
    reasonCode: row.reason_code == null ? null : String(row.reason_code),
    parentIdentity: row.parent_identity == null ? null : String(row.parent_identity),
    fieldPathsJson: String(row.field_paths_json),
    rawPayloadBytes: Number(row.raw_payload_bytes),
    rawPayloadSha256: String(row.raw_payload_sha256),
    rawPayloadJson: String(row.raw_payload_json),
  }));
  const quarantine = (statements.quarantineDigestRows.all(sourceKind, sourceSha256) as Row[]).map(
    (row) => ({
      collection: String(row.collection),
      identity: String(row.source_record_identity),
      ordinal: Number(row.source_ordinal),
      reasonCode: String(row.reason_code),
      fieldPathsJson: String(row.field_paths_json),
      parentSourceIdentity: row.parent_source_identity == null ? null : String(row.parent_source_identity),
      ownerMappingSha256: String(row.owner_mapping_sha256),
      resolutionStatus: String(row.resolution_status),
      rawPayloadBytes: Number(row.raw_payload_bytes),
      rawPayloadSha256: String(row.raw_payload_sha256),
      rawPayloadJson: String(row.raw_payload_json),
    }),
  );
  return sha256Text(
    JSON.stringify({
      targetUserId: manifestFacts.targetUserId,
      sourceKind: manifestFacts.sourceKind,
      sourceSha256: manifestFacts.sourceSha256,
      sourceByteLength: manifestFacts.sourceByteLength,
      sourceSchemaVersion: manifestFacts.sourceSchemaVersion,
      originalFilenameOrExportLabel: manifestFacts.originalFilenameOrExportLabel,
      capturedAt: manifestFacts.capturedAt,
      sanitizationOrOriginRecord: manifestFacts.sanitizationOrOriginRecord,
      ownerMappingSha256: manifestFacts.ownerMappingSha256,
      importerContractVersion: manifestFacts.importerContractVersion,
      runState: manifestFacts.runState,
      countersJson: manifestFacts.countersJson,
      unknownTopLevelKeysJson: manifestFacts.unknownTopLevelKeysJson,
      backupSha256: manifestFacts.backupSha256,
      restoreLocation: manifestFacts.restoreLocation,
      targets,
      traces,
      quarantine,
    }),
  );
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
      " counters_json, payload_digest, backup_sha256, restore_location," +
      " unknown_top_level_keys_json, created_at" +
      " ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      "SELECT collection, source_record_identity, source_ordinal, reason_code," +
      " field_paths_json, parent_source_identity, owner_mapping_sha256, resolution_status," +
      " raw_payload_bytes, raw_payload_sha256, raw_payload_json FROM import_quarantine" +
      " WHERE source_kind = ? AND source_sha256 = ? ORDER BY collection, source_record_identity",
    ),
    batchById: database.prepare(
      "SELECT user_id, id, revision, current_day, status, data_json," +
      " idempotency_key, created_at, updated_at" +
      " FROM batches WHERE user_id = ? AND id = ?",
    ),
    observationById: database.prepare(
      "SELECT user_id, id, batch_id, date_local, observed_at, batch_revision, data_json," +
      " idempotency_key, created_at" +
      " FROM daily_observations WHERE user_id = ? AND id = ?",
    ),
    traceDigestRows: database.prepare(
      "SELECT collection, record_identity, source_ordinal, disposition," +
      " reason_code, parent_identity, field_paths_json," +
      " raw_payload_bytes, raw_payload_sha256, raw_payload_json FROM import_record_traces" +
      " WHERE source_kind = ? AND source_sha256 = ? ORDER BY collection, source_ordinal",
    ),
    insertBackupEvidence: database.prepare(
      "INSERT INTO import_backup_evidence (" +
      " id, import_run_id, sha256, restore_location, schema_digest, migration_ledger_sha256," +
      " application_version, importer_contract_version, integrity, foreign_key_violations," +
      " pre_import_content_digest, pre_import_commit, source_sha256, owner_mapping_sha256," +
      " created_at" +
      " ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    findBackupEvidence: database.prepare(
      "SELECT * FROM import_backup_evidence WHERE import_run_id = ?",
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
        row.unknownTopLevelKeysJson,
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
    querySourceDigest(sourceKind, sourceSha256, targetUserId, manifestFacts) {
      return computeSourceDigest(
        statements,
        sourceKind,
        sourceSha256,
        targetUserId,
        manifestFacts,
      );
    },
    createBackup(context: { sourceSha256: string; ownerMappingSha256: string; preImportCommit: string }): BackupEvidence {
      const directory = mkdtempSync(join(tmpdir(), "naibaji-import-backup-"));
      const backupPath = join(directory, "backup.db");
      database.exec("VACUUM INTO '" + backupPath + "'");
      const check = new DatabaseSync(backupPath, { readOnly: true });
      let integrity = "ok";
      let foreignKeyViolations = 0;
      let schemaDigest = "";
      let migrationLedgerSha256 = "";
      try {
        integrity = String(check.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "");
        if (integrity !== "ok") {
          throw new ImportError("backup integrity check failed: " + integrity);
        }
        foreignKeyViolations = (check.prepare("PRAGMA foreign_key_check").all() as Row[]).length;
        if (foreignKeyViolations !== 0) {
          throw new ImportError("backup foreign-key violations: " + foreignKeyViolations);
        }
        const schemaRows = check
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema" +
            " WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
        schemaDigest = sha256Text(JSON.stringify(schemaRows));
        const ledgerRows = check
          .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
          .all();
        migrationLedgerSha256 = sha256Text(JSON.stringify(ledgerRows));
      } finally {
        check.close();
      }
      // sealed pre-import proof (contract 11, P2-4-F07.1): the pre-import
      // content digest is computed FROM the backup snapshot itself by the
      // backup authority - the restore path may only consume this evidence,
      // never arbitrary caller input
      return {
        sha256: sha256File(backupPath),
        restoreLocation: backupPath,
        schemaDigest,
        migrationLedgerSha256,
        applicationVersion: "0.1.0",
        importerContractVersion: "p2-4-import-v1",
        integrity,
        foreignKeyViolations,
        preImportContentDigest: computeDestinationDigest(backupPath),
        preImportCommit: context.preImportCommit,
        sourceSha256: context.sourceSha256,
        ownerMappingSha256: context.ownerMappingSha256,
        createdAt: new Date().toISOString(),
      };
    },
    insertBackupEvidence(row: ImportBackupEvidenceRow) {
      statements.insertBackupEvidence.run(
        row.id,
        row.importRunId,
        row.sha256,
        row.restoreLocation,
        row.schemaDigest,
        row.migrationLedgerSha256,
        row.applicationVersion,
        row.importerContractVersion,
        row.integrity,
        row.foreignKeyViolations,
        row.preImportContentDigest,
        row.preImportCommit,
        row.sourceSha256,
        row.ownerMappingSha256,
        row.createdAt,
      );
    },
    findBackupEvidenceByRunId(importRunId) {
      const row = statements.findBackupEvidence.get(importRunId) as Row | undefined;
      if (row === undefined) return null;
      return {
        id: String(row.id),
        importRunId: String(row.import_run_id),
        sha256: String(row.sha256),
        restoreLocation: String(row.restore_location),
        schemaDigest: String(row.schema_digest),
        migrationLedgerSha256: String(row.migration_ledger_sha256),
        applicationVersion: String(row.application_version),
        importerContractVersion: String(row.importer_contract_version),
        integrity: String(row.integrity),
        foreignKeyViolations: Number(row.foreign_key_violations),
        preImportContentDigest: String(row.pre_import_content_digest),
        preImportCommit: String(row.pre_import_commit),
        sourceSha256: String(row.source_sha256),
        ownerMappingSha256: String(row.owner_mapping_sha256),
        createdAt: String(row.created_at),
      };
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
 * Content-bearing digest of the COMPLETE destination state: every authority
 * table in the schema (users, business rows, SOP/plan/decision tables,
 * migration ledger, and all import provenance tables) is enumerated from
 * sqlite_schema and hashed. Used by the restore receipt to prove that the
 * post-restore destination is byte-equivalent to the pre-import destination
 * (frozen contract 11, P2-4-F07.1).
 */
export function computeDestinationDigest(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = (table: string) =>
      database.prepare("SELECT * FROM \"" + table + "\" ORDER BY rowid").all() as Row[];
    const tables = (database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table'" +
      " AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Row[]).map((row) => String(row.name));
    const state: Record<string, Row[]> = {};
    for (const table of tables) {
      state[table] = rows(table);
    }
    return sha256Text(JSON.stringify(state));
  } finally {
    database.close();
  }
}

export interface RestoreReceipt {
  readonly backupSha256: string;
  readonly preImportContentDigest: string;
  readonly preImportCommit: string;
  readonly sourceSha256: string;
  readonly ownerMappingSha256: string;
  readonly postRestoreDigest: string;
  readonly digestMatch: boolean;
  readonly integrity: string;
  readonly foreignKeyViolations: number;
  readonly restoredAt: string;
  readonly restoreSource: string;
  readonly restoreTarget: string;
}

/**
 * Restore a database file from an import backup snapshot, consuming ONLY
 * the evidence sealed by the backup authority (contract 11, P2-4-F07.1):
 * backup SHA is verified before any mutation, then the restored file must
 * match the sealed pre-import content digest with integrity ok and zero
 * foreign-key violations - otherwise the restore FAILS CLOSED (throws) and
 * no receipt is emitted. The caller must close the live connection first;
 * stale WAL/SHM sidecar files are removed so the restored file is
 * authoritative.
 */
export function restoreDatabaseFromBackup(
  databasePath: string,
  backupPath: string,
  evidence: BackupEvidence,
): RestoreReceipt {
  if (!existsSync(backupPath)) throw new ImportError("backup file missing: " + backupPath);
  if (sha256File(backupPath) !== evidence.sha256) {
    throw new ImportError("restore aborted: backup SHA-256 mismatch");
  }
  copyFileSync(backupPath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = databasePath + suffix;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
  const restored = new DatabaseSync(databasePath, { readOnly: true });
  let integrity = "ok";
  let foreignKeyViolations = 0;
  try {
    integrity = String(restored.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "");
    foreignKeyViolations = (restored.prepare("PRAGMA foreign_key_check").all() as Row[]).length;
  } finally {
    restored.close();
  }
  const postRestoreDigest = computeDestinationDigest(databasePath);
  const digestMatch = postRestoreDigest === evidence.preImportContentDigest;
  if (!digestMatch || integrity !== "ok" || foreignKeyViolations !== 0) {
    throw new ImportError(
      "restore failed closed: digestMatch=" + digestMatch +
      " integrity=" + integrity +
      " foreignKeyViolations=" + foreignKeyViolations +
      " (sealed preImportContentDigest=" + evidence.preImportContentDigest +
      " postRestoreDigest=" + postRestoreDigest + ")",
    );
  }
  return {
    backupSha256: evidence.sha256,
    preImportContentDigest: evidence.preImportContentDigest,
    preImportCommit: evidence.preImportCommit,
    sourceSha256: evidence.sourceSha256,
    ownerMappingSha256: evidence.ownerMappingSha256,
    postRestoreDigest,
    digestMatch: true,
    integrity,
    foreignKeyViolations,
    restoredAt: new Date().toISOString(),
    restoreSource: backupPath,
    restoreTarget: databasePath,
  };
}
