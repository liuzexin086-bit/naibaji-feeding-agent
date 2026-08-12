import {
  cloneObservationPayload,
  domainObservationToLegacyPayload,
  legacyObservationToDomain,
} from "./observation-codec.js";
import type {
  AppendObservationInput,
  ObservationRepository,
  ObservationRepositoryEntry,
  ObservationStorePort,
  ObservationStoreRow,
  PersistedObservation,
  QuarantinedObservation,
} from "./contracts.js";

/** SQLite adapter over the existing daily_observations table/LocalStore seam. */
export class SqliteObservationRepository implements ObservationRepository {
  public constructor(private readonly store: ObservationStorePort) {}

  public append(input: AppendObservationInput): PersistedObservation {
    const row = this.store.appendDailyObservation({
      userId: input.userId,
      batchId: input.batchId,
      dateLocal: input.dateLocal,
      observedAt: input.observedAt ?? input.observation.recordedAt,
      batchRevision: input.batchRevision,
      id: input.id ?? input.observation.id,
      idempotencyKey: input.idempotencyKey,
      data: domainObservationToLegacyPayload(input.observation, input.raw),
    });
    return this.decode(row);
  }

  public list(userId: string, batchId: string): ObservationRepositoryEntry[] {
    return this.store.listObservations(userId, batchId).map((row) => {
      try {
        return this.decode(row);
      } catch (error) {
        const quarantine: QuarantinedObservation = {
          kind: "quarantine",
          id: row.id,
          userId: row.userId,
          batchId: row.batchId,
          raw: cloneObservationPayload(row.data),
          reason: error instanceof Error ? error.message : "PERSISTENCE_OBSERVATION_INVALID",
        };
        return quarantine;
      }
    });
  }

  private decode(row: ObservationStoreRow): PersistedObservation {
    const raw = cloneObservationPayload(row.data);
    const observation = legacyObservationToDomain({
      ...raw,
      ...(raw.recordedAt === undefined ? { recordedAt: row.observedAt } : {}),
    });
    return {
      id: row.id,
      userId: row.userId,
      batchId: row.batchId,
      dateLocal: row.dateLocal,
      observedAt: row.observedAt,
      batchRevision: row.batchRevision,
      observation,
      raw,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
    };
  }
}
