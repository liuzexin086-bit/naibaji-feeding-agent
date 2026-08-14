/**
 * P2-4 import contracts: one import application authority with ports for the
 * persistence adapters (contract 13). Dependency direction:
 *   source adapter -> import application service -> persistence ports -> SQLite adapters
 */

export const IMPORTER_CONTRACT_VERSION = "p2-4-import-v1";

export type Disposition =
  | "mapped"
  | "preserved_raw"
  | "exact_duplicate"
  | "quarantined";

export type RunState =
  | "COMPLETE"
  | "PRESERVED_WITH_QUARANTINE"
  | "INCOMPLETE"
  | "FAILED_ROLLED_BACK";

export const JSON_V1_COLLECTIONS = [
  "batches",
  "dailyRecords",
  "weighSamples",
  "recommendations",
  "approvals",
  "executions",
  "sceneStates",
  "modelRegistry",
  "auditLogs",
] as const;

export interface SourceFacts {
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly sourceSchemaVersion: string;
  readonly originalFilenameOrExportLabel: string | null;
  readonly capturedAt: string | null;
  readonly sanitizationOrOriginRecord: string | null;
}

export interface OwnerMappingManifest {
  readonly formatVersion: number;
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly targetUserId: string;
  readonly mappingNote?: string;
  readonly createdAt?: string;
}

export interface CollectionCounters {
  sourceRows: number;
  mappedNew: number;
  replayExisting: number;
  exactDuplicateOccurrences: number;
  preservedArchive: number;
  quarantined: number;
}

export interface ZeroLossCounters {
  perCollection: Record<string, CollectionCounters>;
  sourceRows: number;
  mappedNew: number;
  replayExisting: number;
  exactDuplicateOccurrences: number;
  preservedArchive: number;
  quarantined: number;
  silentDrops: number;
  unaccountedRows: number;
  unexpectedDuplicates: number;
  targetOrphans: number;
  sourceBytesChanged: number;
}

export function emptyCounters(): ZeroLossCounters {
  return {
    perCollection: {},
    sourceRows: 0,
    mappedNew: 0,
    replayExisting: 0,
    exactDuplicateOccurrences: 0,
    preservedArchive: 0,
    quarantined: 0,
    silentDrops: 0,
    unaccountedRows: 0,
    unexpectedDuplicates: 0,
    targetOrphans: 0,
    sourceBytesChanged: 0,
  };
}

export interface ImportManifestRow {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly sourceSchemaVersion: string;
  readonly originalFilenameOrExportLabel: string | null;
  readonly capturedAt: string | null;
  readonly sanitizationOrOriginRecord: string | null;
  readonly ownerMappingSha256: string;
  readonly targetUserId: string;
  readonly importerContractVersion: string;
  readonly runState: RunState;
  readonly countersJson: string;
  readonly payloadDigest: string;
  readonly backupSha256: string | null;
  readonly restoreLocation: string | null;
  readonly unknownTopLevelKeysJson: string | null;
  readonly createdAt: string;
}

export interface TraceRow {
  readonly importRunId: string;
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly collection: string;
  readonly recordIdentity: string;
  readonly sourceOrdinal: number;
  readonly disposition: Disposition;
  readonly targetTable: string | null;
  readonly targetId: string | null;
  readonly rawPayloadBytes: number;
  readonly rawPayloadSha256: string;
  readonly rawPayloadJson: string;
  readonly reasonCode: string | null;
  readonly fieldPathsJson: string | null;
  readonly parentIdentity: string | null;
  readonly ownerMappingSha256: string;
  readonly createdAt: string;
}

export interface QuarantineRow {
  readonly id: number;
  readonly importRunId: string;
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly collection: string;
  readonly sourceRecordIdentity: string;
  readonly sourceOrdinal: number;
  readonly rawPayloadBytes: number;
  readonly rawPayloadSha256: string;
  readonly rawPayloadJson: string;
  readonly reasonCode: string;
  readonly fieldPathsJson: string | null;
  readonly parentSourceIdentity: string | null;
  readonly ownerMappingSha256: string;
  readonly createdAt: string;
  readonly resolutionStatus: "unresolved" | "resolved";
}

export interface TargetBatchInput {
  readonly userId: string;
  readonly id: string;
  readonly revision: number;
  readonly currentDay: number;
  readonly status: string;
  readonly dataJson: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TargetObservationInput {
  readonly userId: string;
  readonly id: string;
  readonly batchId: string;
  readonly dateLocal: string;
  readonly observedAt: string;
  readonly batchRevision: number;
  readonly dataJson: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/**
 * Frozen ReplayDigestProjection entry for a mapped target row (contract 8/10):
 * every authoritative persisted column of batches and daily_observations is
 * bound, not only data_json. Columns that do not exist for the other table
 * are null.
 */
export interface TargetRowDigestEntry {
  readonly table: "batches" | "daily_observations";
  readonly id: string;
  readonly dataJson: string;
  // batches authoritative columns
  readonly revision: number | null;
  readonly currentDay: number | null;
  readonly status: string | null;
  // daily_observations authoritative columns
  readonly batchId: string | null;
  readonly dateLocal: string | null;
  readonly observedAt: string | null;
  readonly batchRevision: number | null;
  // lifecycle/revision/timestamps shared by both tables
  readonly idempotencyKey: string | null;
  readonly createdAt: string | null;
  // batches only (null for daily_observations, which have no updated_at)
  readonly updatedAt: string | null;
}

/**
 * Backup evidence sealed by the backup authority at creation time (contract
 * 11, P2-4-F07.1): the pre-import content digest is computed FROM the
 * backup snapshot itself, and the pre-import commit plus source/owner
 * hashes are sealed so a later restore can consume only this evidence.
 */
export interface BackupEvidence {
  readonly sha256: string;
  readonly restoreLocation: string;
  readonly schemaDigest: string;
  readonly migrationLedgerSha256: string;
  readonly applicationVersion: string;
  readonly importerContractVersion: string;
  readonly integrity: string;
  readonly foreignKeyViolations: number;
  /** Complete destination content digest of the backup snapshot itself. */
  readonly preImportContentDigest: string;
  /** Pre-import commit of the import operation (caller-provided fact). */
  readonly preImportCommit: string;
  readonly sourceSha256: string;
  readonly ownerMappingSha256: string;
  readonly createdAt: string;
}

export interface ImportBackupEvidenceRow extends BackupEvidence {
  readonly id: string;
  readonly importRunId: string;
}

/**
 * Frozen ReplayDigestProjection manifest facts (contract 8/10, P2-4-F05.1):
 * every immutable semantic manifest field except payload_digest itself and
 * the audit-only created_at timestamp.
 */
export interface ManifestDigestFacts {
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly sourceSchemaVersion: string;
  readonly originalFilenameOrExportLabel: string | null;
  readonly capturedAt: string | null;
  readonly sanitizationOrOriginRecord: string | null;
  readonly ownerMappingSha256: string;
  readonly targetUserId: string;
  readonly importerContractVersion: string;
  readonly runState: string;
  readonly countersJson: string;
  readonly unknownTopLevelKeysJson: string | null;
  readonly backupSha256: string;
  readonly restoreLocation: string;
}

export interface ImportPersistencePort {
  readonly databasePath: string;
  findManifestBySource(sourceKind: string, sourceSha256: string): ImportManifestRow | null;
  findUserById(userId: string): boolean;
  insertManifest(row: ImportManifestRow): void;
  insertTrace(row: TraceRow): void;
  findQuarantineBySourceRecordIdentity(
    sourceKind: string,
    sourceSha256: string,
    collection: string,
    sourceRecordIdentity: string,
  ): QuarantineRow | null;
  insertQuarantine(row: Omit<QuarantineRow, "id">): void;
  listQuarantine(limit?: number): QuarantineRow[];
  countQuarantineUnresolved(): number;
  findBatchByImportKey(userId: string, idempotencyKey: string): boolean;
  findObservationByImportKey(userId: string, idempotencyKey: string): boolean;
  insertBatch(input: TargetBatchInput): void;
  insertObservation(input: TargetObservationInput): void;
  querySourceDigest(
    sourceKind: string,
    sourceSha256: string,
    targetUserId: string,
    manifestFacts: ManifestDigestFacts,
  ): string;
  createBackup(context: {
    sourceSha256: string;
    ownerMappingSha256: string;
    preImportCommit: string;
  }): BackupEvidence;
  insertBackupEvidence(row: ImportBackupEvidenceRow): void;
  findBackupEvidenceByRunId(importRunId: string): ImportBackupEvidenceRow | null;
  integrity(): { integrity: string; foreignKeyViolations: number };
  transaction<T>(operation: () => T): T;
}

export interface ImportRunResult {
  readonly runId: string;
  readonly state: RunState;
  readonly replay: boolean;
  readonly counters: ZeroLossCounters;
  readonly backup: BackupEvidence;
  readonly payloadDigest: string;
  readonly targetUserId: string;
  readonly ownerMappingSha256: string;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export class ImportOwnerMappingMismatchError extends ImportError {
  constructor(sourceKind: string, sourceSha256: string, expected: string, actual: string) {
    super(
      "owner-mapping-mismatch for " + sourceKind + " " + sourceSha256 +
      " expected " + expected + " got " + actual,
    );
    this.name = "ImportOwnerMappingMismatchError";
  }
}
