import type { Observation } from "../domain/observation.js";

/**
 * JSON payload retained by the existing daily_observations row.
 *
 * The persistence boundary deliberately keeps this structural type local. It
 * is not the Domain Observation contract: legacy/UI/runtime metadata may be
 * present and must remain recoverable until a separately authorized import or
 * cutover stage handles it.
 */
export type ObservationRawPayload = Record<string, unknown>;

/** Persistence-owned row shape for the existing SQLite observation table. */
export interface ObservationStoreRow {
  id: string;
  userId: string;
  batchId: string;
  dateLocal: string;
  observedAt: string;
  batchRevision: number;
  data: ObservationRawPayload;
  idempotencyKey: string;
  createdAt: string;
}

/** Persistence-owned append shape; optionality matches the legacy LocalStore seam. */
export interface ObservationStoreInput {
  userId: string;
  batchId: string;
  dateLocal: string;
  observedAt?: string;
  batchRevision: number;
  data: ObservationRawPayload;
  id?: string;
  idempotencyKey: string;
}

/** Storage-facing port required by the observation repository adapter. */
export interface ObservationStorePort {
  appendDailyObservation(input: ObservationStoreInput): ObservationStoreRow;
  listObservations(userId: string, batchId: string): ObservationStoreRow[];
}

/**
 * The repository's lossless envelope: `raw` is the full legacy payload, while
 * `observation` is only the validated Domain projection. Unknown metadata is
 * never folded into the Domain contract.
 */
export interface ObservationEnvelope {
  readonly raw: ObservationRawPayload;
  readonly observation: Observation;
}

export interface AppendObservationInput {
  readonly userId: string;
  readonly batchId: string;
  readonly dateLocal: string;
  readonly observedAt?: string;
  readonly batchRevision: number;
  readonly observation: Observation;
  readonly id?: string;
  readonly idempotencyKey: string;
  /** Optional existing/full legacy payload whose unknown metadata is retained. */
  readonly raw?: ObservationRawPayload;
}

export interface PersistedObservation extends ObservationEnvelope {
  readonly id: string;
  readonly userId: string;
  readonly batchId: string;
  readonly dateLocal: string;
  readonly observedAt: string;
  readonly batchRevision: number;
  /** Full persisted payload; `observation` is a Domain-only projection of it. */
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface QuarantinedObservation {
  readonly kind: "quarantine";
  readonly id: string;
  readonly userId: string;
  readonly batchId: string;
  /** Untouched full payload retained when Domain projection fails validation. */
  readonly raw: ObservationRawPayload;
  readonly reason: string;
}

export type ObservationRepositoryEntry = PersistedObservation | QuarantinedObservation;

export interface ObservationRepository {
  append(input: AppendObservationInput): PersistedObservation;
  list(userId: string, batchId: string): ObservationRepositoryEntry[];
}
