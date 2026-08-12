import type {
  AppendDailyObservationInput,
  DailyObservation,
} from "../shared/local-store-contract.js";
import type { Observation } from "../domain/observation.js";

/** Storage-facing port required by the observation repository adapter. */
export interface ObservationStorePort {
  appendDailyObservation(input: AppendDailyObservationInput): DailyObservation;
  listObservations(userId: string, batchId: string): DailyObservation[];
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
}

export interface PersistedObservation {
  readonly id: string;
  readonly userId: string;
  readonly batchId: string;
  readonly dateLocal: string;
  readonly observedAt: string;
  readonly batchRevision: number;
  readonly observation: Observation;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface QuarantinedObservation {
  readonly kind: "quarantine";
  readonly id: string;
  readonly userId: string;
  readonly batchId: string;
  readonly raw: Record<string, unknown>;
  readonly reason: string;
}

export type ObservationRepositoryEntry = PersistedObservation | QuarantinedObservation;

export interface ObservationRepository {
  append(input: AppendObservationInput): PersistedObservation;
  list(userId: string, batchId: string): ObservationRepositoryEntry[];
}
