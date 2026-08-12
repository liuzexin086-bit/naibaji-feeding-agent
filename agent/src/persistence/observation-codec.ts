import {
  parseObservation,
  type Observation,
  type RawObservationInput,
} from "../domain/observation.js";

export type LegacyObservationPayload = Record<string, unknown>;

const DOMAIN_KEYS = [
  "id",
  "recordedAt",
  "diarrheaGrade",
  "creepGrade",
  "deviceStatus",
  "feedingResponse",
  "actualPowderGrams",
] as const;

/**
 * Decode the legacy JSON shape into the typed Domain contract.
 *
 * Legacy rows may contain UI/runtime metadata. Only fields owned by the
 * Observation contract are projected; invalid owned values fail closed.
 */
export function legacyObservationToDomain(raw: unknown): Observation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PERSISTENCE_OBSERVATION_INVALID");
  }
  const source = raw as Record<string, unknown>;
  const projected: RawObservationInput = {};
  for (const key of DOMAIN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      (projected as Record<string, unknown>)[key] = source[key];
    }
  }
  try {
    return parseObservation(projected);
  } catch {
    throw new Error("PERSISTENCE_OBSERVATION_INVALID");
  }
}

/** Encode Domain presence without collapsing omission and explicit `none`. */
export function domainObservationToLegacyPayload(
  observation: Observation,
): LegacyObservationPayload {
  const payload: LegacyObservationPayload = {};
  const fields = [
    "diarrheaGrade",
    "creepGrade",
    "deviceStatus",
    "feedingResponse",
  ] as const;
  for (const field of fields) {
    const presence = observation[field];
    if (presence.kind === "observed") payload[field] = presence.value;
  }
  // Null is explicit in the persistence payload so null and zero remain
  // distinguishable after a close/reopen round-trip.
  payload.actualPowderGrams = observation.actualPowderGrams;
  if (observation.id !== undefined) payload.id = observation.id;
  if (observation.recordedAt !== undefined) payload.recordedAt = observation.recordedAt;
  return payload;
}
