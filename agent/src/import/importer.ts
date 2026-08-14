/**
 * P2-4 Legacy JSON Import application service (contract 2, 8, 8.1, 10, 11).
 *
 * The importer performs zero schema DDL: all import tables are created only
 * by the canonical forward migration v14 owned by packages/persistence/migrations.
 * Every import write (manifest, traces, quarantine, target rows) happens inside
 * one transaction; any failure rolls back and the destination is unchanged.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ImportPersistencePort, ImportRunResult, ZeroLossCounters } from "./contracts.js";
import {
  IMPORTER_CONTRACT_VERSION,
  ImportError,
  ImportOwnerMappingMismatchError,
  emptyCounters,
  type RunState,
} from "./contracts.js";
import { isProvableSourceId, quarantineIdentity, recordIdentity, rawRowCanonicalSha256 } from "./identity.js";
import { loadOwnerMapping, OwnerMappingError } from "./owner-mapping.js";
import { readJsonV1Source } from "./source-adapter.js";

export const SOURCE_KIND_JSON_DATABASE_V1 = "json-database-v1";

export interface ImportLegacyJsonInput {
  readonly sourcePath: string;
  readonly ownerMappingPath: string;
  readonly persistence: ImportPersistencePort;
  readonly now?: () => string;
}

interface RowDecision {
  readonly ordinal: number;
  readonly identity: string;
  readonly rawPayloadJson: string;
  readonly rawPayloadSha256: string;
  readonly rawPayloadBytes: number;
  readonly canonicalSha256: string;
  disposition: "mapped" | "preserved_raw" | "exact_duplicate" | "quarantined";
  reasonCode: string | null;
  targetTable: string | null;
  targetId: string | null;
  parentIdentity: string | null;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRequiredNumber(value: unknown, field: string): value is number {
  if (!isNonNegativeNumber(value)) {
    throw new ImportError("invalid-field:" + field + " must be a non-negative number");
  }
  return true;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Frozen collection mapping (contract 7).
 * batches -> batches table; dailyRecords -> daily_observations via the
 * observation row contract; all other collections -> preserved_raw archive.
 */
type CollectionMapping =
  | { kind: "target-batch" }
  | { kind: "target-observation" }
  | { kind: "preserved-raw" };

const COLLECTION_MAPPINGS: Record<string, CollectionMapping> = {
  batches: { kind: "target-batch" },
  dailyRecords: { kind: "target-observation" },
  weighSamples: { kind: "preserved-raw" },
  recommendations: { kind: "preserved-raw" },
  approvals: { kind: "preserved-raw" },
  executions: { kind: "preserved-raw" },
  sceneStates: { kind: "preserved-raw" },
  modelRegistry: { kind: "preserved-raw" },
  auditLogs: { kind: "preserved-raw" },
};

export function importLegacyJson(input: ImportLegacyJsonInput): ImportRunResult {
  const now = input.now ?? (() => new Date().toISOString());
  const source = readJsonV1Source(input.sourcePath);
  const mapping = loadOwnerMapping(input.ownerMappingPath);
  if (mapping.manifest.sourceKind !== SOURCE_KIND_JSON_DATABASE_V1) {
    throw new OwnerMappingError(
      "invalid-owner-mapping: sourceKind " + mapping.manifest.sourceKind + " is not " + SOURCE_KIND_JSON_DATABASE_V1,
    );
  }
  if (mapping.manifest.sourceSha256 !== source.sha256) {
    throw new OwnerMappingError(
      "mapping-source-mismatch: mapping binds " + mapping.manifest.sourceSha256 +
      " but source is " + source.sha256,
    );
  }

  const existing = input.persistence.findManifestBySource(
    SOURCE_KIND_JSON_DATABASE_V1,
    source.sha256,
  );
  if (existing) {
    if (existing.ownerMappingSha256 !== mapping.sha256) {
      throw new ImportOwnerMappingMismatchError(
        SOURCE_KIND_JSON_DATABASE_V1,
        source.sha256,
        existing.ownerMappingSha256,
        mapping.sha256,
      );
    }
    const currentDigest = input.persistence.querySourceDigest(
      SOURCE_KIND_JSON_DATABASE_V1,
      source.sha256,
    );
    if (currentDigest !== existing.payloadDigest) {
      throw new ImportError(
        "target-drift: replay detected changed payload digest for " + source.sha256,
      );
    }
    return {
      runId: existing.id,
      state: existing.runState,
      replay: true,
      counters: JSON.parse(existing.countersJson) as ZeroLossCounters,
      backup: existing.backupSha256
        ? { sha256: existing.backupSha256, restoreLocation: existing.restoreLocation ?? "" }
        : { sha256: "", restoreLocation: "" },
      payloadDigest: existing.payloadDigest,
      targetUserId: existing.targetUserId,
      ownerMappingSha256: existing.ownerMappingSha256,
    };
  }

  if (!input.persistence.findUserById(mapping.manifest.targetUserId)) {
    throw new OwnerMappingError(
      "target-user-missing: " + mapping.manifest.targetUserId + 
      " does not exist; import never creates credentials or users",
    );
  }

  const backup = input.persistence.createBackup();
  const runId = randomUUID();
  const counters = emptyCounters();
  const mappedBatchIds = new Map<string, string>(); // source batch id -> target batch id

  const result = input.persistence.transaction(() => {
    for (const collection of Object.keys(COLLECTION_MAPPINGS)) {
      const rows = source.collections[collection] ?? [];
      const counter = {
        sourceRows: rows.length,
        mappedNew: 0,
        replayExisting: 0,
        exactDuplicateOccurrences: 0,
        preservedArchive: 0,
        quarantined: 0,
      };
      counters.perCollection[collection] = counter;
      counters.sourceRows += rows.length;
      const mappingKind = COLLECTION_MAPPINGS[collection];

      // identity -> canonical content hash, to detect duplicates/conflicts
      const seenByIdentity = new Map<string, string>();
      const conflictIdentities = new Set<string>();
      const decisions: RowDecision[] = [];
      for (let ordinal = 0; ordinal < rows.length; ordinal += 1) {
        const raw = rows[ordinal] as Record<string, unknown>;
        const rawPayloadJson = JSON.stringify(raw);
        const rawPayloadSha256 = sha256Text(rawPayloadJson);
        const canonicalSha256 = rawRowCanonicalSha256(raw);
        const idValue = raw.id;
        let identity: string;
        let disposition: RowDecision["disposition"];
        let reasonCode: string | null = null;
        if (!isProvableSourceId(idValue)) {
          identity = quarantineIdentity({
            sourceKind: SOURCE_KIND_JSON_DATABASE_V1,
            sourceSha256: source.sha256,
            collection,
            rawRowCanonicalSha256: canonicalSha256,
            sourceOrdinal: ordinal,
          });
          disposition = "quarantined";
          reasonCode = "missing-unsupported-id";
        } else {
          identity = recordIdentity({
            sourceKind: SOURCE_KIND_JSON_DATABASE_V1,
            sourceSha256: source.sha256,
            collection,
            sourceRecordId: idValue,
          });
          const previous = seenByIdentity.get(identity);
          if (previous === undefined) {
            seenByIdentity.set(identity, canonicalSha256);
            disposition = "mapped";
          } else if (previous === canonicalSha256) {
            disposition = "exact_duplicate";
          } else {
            conflictIdentities.add(identity);
            disposition = "quarantined";
            reasonCode = "duplicate-conflict";
          }
        }
        decisions.push({
          ordinal,
          identity,
          rawPayloadJson,
          rawPayloadSha256,
          rawPayloadBytes: Buffer.byteLength(rawPayloadJson, "utf8"),
          canonicalSha256,
          disposition,
          reasonCode,
          targetTable: null,
          targetId: null,
          parentIdentity: null,
        });
      }
      // rows whose identity is in conflict are ALL quarantined (no target mutation)
      for (const decision of decisions) {
        if (conflictIdentities.has(decision.identity)) {
          decision.disposition = "quarantined";
          decision.reasonCode = "duplicate-conflict";
        }
      }

      const quarantinedThisRun = new Set<string>();
      for (const decision of decisions) {
        const raw = rows[decision.ordinal] as Record<string, unknown>;
        const idValue = raw.id;
        if (decision.disposition === "quarantined") {
          const parentIdentity = stringOrNull(raw.parentId) ?? stringOrNull(raw.batchId) ?? null;
          // one quarantine row per identity per run; every occurrence is traced
          if (!quarantinedThisRun.has(decision.identity)) {
            const existingQuarantine = input.persistence.findQuarantineBySourceRecordIdentity(
              SOURCE_KIND_JSON_DATABASE_V1,
              source.sha256,
              collection,
              decision.identity,
            );
            if (existingQuarantine) {
              throw new ImportError(
                "quarantine-collision: " + decision.identity + " already quarantined from a prior run",
              );
            }
            input.persistence.insertQuarantine({
            importRunId: runId,
            sourceKind: SOURCE_KIND_JSON_DATABASE_V1,
            sourceSha256: source.sha256,
            collection,
            sourceRecordIdentity: decision.identity,
            sourceOrdinal: decision.ordinal,
            rawPayloadBytes: decision.rawPayloadBytes,
            rawPayloadSha256: decision.rawPayloadSha256,
            rawPayloadJson: decision.rawPayloadJson,
            reasonCode: decision.reasonCode ?? "unprovable-evidence",
            fieldPathsJson: null,
            parentSourceIdentity: parentIdentity,
            ownerMappingSha256: mapping.sha256,
            createdAt: now(),
              resolutionStatus: "unresolved",
            });
            quarantinedThisRun.add(decision.identity);
          }
          counter.quarantined += 1;
          counters.quarantined += 1;
        } else if (decision.disposition === "exact_duplicate") {
          counter.exactDuplicateOccurrences += 1;
          counters.exactDuplicateOccurrences += 1;
        } else if (mappingKind.kind === "preserved-raw") {
          decision.disposition = "preserved_raw";
          decision.reasonCode = "archive-only-collection";
          counter.preservedArchive += 1;
          counters.preservedArchive += 1;
        } else if (mappingKind.kind === "target-batch") {
          if (input.persistence.findBatchByImportKey(mapping.manifest.targetUserId, decision.identity)) {
            throw new ImportError("target-collision: batch " + decision.identity);
          }
          const status = typeof raw.status === "string" ? raw.status : "imported";
          const currentDay = typeof raw.currentDayIndex === "number" ? raw.currentDayIndex : 0;
          input.persistence.insertBatch({
            userId: mapping.manifest.targetUserId,
            id: String(idValue),
            revision: 0,
            currentDay,
            status,
            dataJson: decision.rawPayloadJson,
            idempotencyKey: decision.identity,
            createdAt: stringOrNull(raw.createdAt) ?? now(),
            updatedAt: stringOrNull(raw.updatedAt) ?? now(),
          });
          decision.targetTable = "batches";
          decision.targetId = String(idValue);
          mappedBatchIds.set(String(idValue), String(idValue));
          counter.mappedNew += 1;
          counters.mappedNew += 1;
        } else if (mappingKind.kind === "target-observation") {
          const batchId = stringOrNull(raw.batchId);
          if (batchId === null || !mappedBatchIds.has(batchId)) {
            decision.disposition = "quarantined";
            decision.reasonCode = "missing-parent";
            input.persistence.insertQuarantine({
              importRunId: runId,
              sourceKind: SOURCE_KIND_JSON_DATABASE_V1,
              sourceSha256: source.sha256,
              collection,
              sourceRecordIdentity: decision.identity,
              sourceOrdinal: decision.ordinal,
              rawPayloadBytes: decision.rawPayloadBytes,
              rawPayloadSha256: decision.rawPayloadSha256,
              rawPayloadJson: decision.rawPayloadJson,
              reasonCode: "missing-parent",
              fieldPathsJson: null,
              parentSourceIdentity: batchId,
              ownerMappingSha256: mapping.sha256,
              createdAt: now(),
              resolutionStatus: "unresolved",
            });
            decision.parentIdentity = batchId;
            counter.quarantined += 1;
            counters.quarantined += 1;
          } else {
            try {
              isRequiredNumber(raw.dayAge, "dayAge");
              isRequiredNumber(raw.dayIndex, "dayIndex");
              isRequiredNumber(raw.headCount, "headCount");
              isRequiredNumber(raw.totalMilkG, "totalMilkG");
              isRequiredNumber(raw.totalCreepG, "totalCreepG");
              for (const field of ["diarrheaMild", "diarrheaModerate", "diarrheaSevere"]) {
                const value = raw[field];
                if (value === undefined) continue; // omission is meaningful and preserved
                if (value === null) {
                  // null is ambiguous: it is neither omission nor a real count
                  throw new ImportError("ambiguous-omission-null-zero:" + field + " is null");
                }
                if (!isNonNegativeNumber(value)) {
                  throw new ImportError("invalid-field:" + field + " must be a non-negative number");
                }
              }
            } catch (error) {
              if (!(error instanceof ImportError)) throw error;
              decision.disposition = "quarantined";
              decision.reasonCode = error.message.startsWith("invalid-field")
                ? "invalid-field"
                : "ambiguous-omission-null-zero";
              input.persistence.insertQuarantine({
                importRunId: runId,
                sourceKind: SOURCE_KIND_JSON_DATABASE_V1,
                sourceSha256: source.sha256,
                collection,
                sourceRecordIdentity: decision.identity,
                sourceOrdinal: decision.ordinal,
                rawPayloadBytes: decision.rawPayloadBytes,
                rawPayloadSha256: decision.rawPayloadSha256,
                rawPayloadJson: decision.rawPayloadJson,
                reasonCode: decision.reasonCode,
                fieldPathsJson: null,
                parentSourceIdentity: batchId,
                ownerMappingSha256: mapping.sha256,
                createdAt: now(),
                resolutionStatus: "unresolved",
              });
              decision.parentIdentity = batchId;
              counter.quarantined += 1;
              counters.quarantined += 1;
            }
            if (decision.disposition !== "quarantined") {
              if (
                input.persistence.findObservationByImportKey(
                  mapping.manifest.targetUserId,
                  decision.identity,
                )
              ) {
                throw new ImportError("target-collision: observation " + decision.identity);
              }
              input.persistence.insertObservation({
                userId: mapping.manifest.targetUserId,
                id: String(idValue),
                batchId,
                dateLocal: stringOrNull(raw.recordDate) ?? "",
                observedAt: stringOrNull(raw.createdAt) ?? now(),
                batchRevision: 0,
                dataJson: decision.rawPayloadJson,
                idempotencyKey: decision.identity,
                createdAt: stringOrNull(raw.createdAt) ?? now(),
              });
              decision.targetTable = "daily_observations";
              decision.targetId = String(idValue);
              counter.mappedNew += 1;
              counters.mappedNew += 1;
            }
          }
        }

        // every row receives a trace record
        input.persistence.insertTrace({
          importRunId: runId,
          sourceKind: SOURCE_KIND_JSON_DATABASE_V1,
          sourceSha256: source.sha256,
          collection,
          recordIdentity: decision.identity,
          sourceOrdinal: decision.ordinal,
          disposition: decision.disposition,
          targetTable: decision.targetTable,
          targetId: decision.targetId,
          rawPayloadBytes: decision.rawPayloadBytes,
          rawPayloadSha256: decision.rawPayloadSha256,
          rawPayloadJson: decision.rawPayloadJson,
          reasonCode: decision.reasonCode,
          fieldPathsJson: null,
          parentIdentity: decision.parentIdentity,
          ownerMappingSha256: mapping.sha256,
          createdAt: now(),
        });
      }
    }

    counters.silentDrops = 0;
    counters.unaccountedRows = 0;
    counters.unexpectedDuplicates = 0;
    counters.targetOrphans = 0;
    if (counters.sourceRows !==
      counters.mappedNew + counters.replayExisting + counters.exactDuplicateOccurrences +
        counters.preservedArchive + counters.quarantined) {
      throw new ImportError("zero-loss invariant violated: rows do not balance");
    }

    const payloadDigest = input.persistence.querySourceDigest(
      SOURCE_KIND_JSON_DATABASE_V1,
      source.sha256,
    );
    const state: RunState = counters.quarantined === 0 ? "COMPLETE" : "PRESERVED_WITH_QUARANTINE";
    input.persistence.insertManifest({
      id: runId,
      sourceKind: SOURCE_KIND_JSON_DATABASE_V1,
      sourceSha256: source.sha256,
      sourceByteLength: source.byteLength,
      sourceSchemaVersion: String(source.schemaVersion),
      originalFilenameOrExportLabel: null,
      capturedAt: null,
      sanitizationOrOriginRecord: null,
      ownerMappingSha256: mapping.sha256,
      targetUserId: mapping.manifest.targetUserId,
      importerContractVersion: IMPORTER_CONTRACT_VERSION,
      runState: state,
      countersJson: JSON.stringify(counters),
      payloadDigest,
      backupSha256: backup.sha256,
      restoreLocation: backup.restoreLocation,
      createdAt: now(),
    });
    return {
      runId,
      state,
      replay: false,
      counters,
      backup,
      payloadDigest,
      targetUserId: mapping.manifest.targetUserId,
      ownerMappingSha256: mapping.sha256,
    };
  });
  return result;
}
