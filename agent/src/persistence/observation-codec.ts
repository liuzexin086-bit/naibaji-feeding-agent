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

const DOMAIN_PRESENCE_KEYS = [
  "diarrheaGrade",
  "creepGrade",
  "deviceStatus",
  "feedingResponse",
] as const;

function payloadObject(raw: unknown): LegacyObservationPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PERSISTENCE_OBSERVATION_INVALID");
  }
  return raw as LegacyObservationPayload;
}

/** Clone the JSON-shaped payload without sharing its top-level envelope. */
export function cloneObservationPayload(raw: unknown): LegacyObservationPayload {
  const source = payloadObject(raw);
  return structuredClone(source) as LegacyObservationPayload;
}

/**
 * Decode the legacy JSON shape into the typed Domain contract.
 *
 * Legacy rows may contain UI/runtime metadata. Only fields owned by the
 * Observation contract are projected; invalid owned values fail closed.
 */
export function legacyObservationToDomain(raw: unknown): Observation {
  const source = payloadObject(raw);
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
  raw: LegacyObservationPayload = {},
): LegacyObservationPayload {
  // This function is an overlay codec, not a full-payload replacement. The
  // raw payload is cloned first so unknown UI/runtime metadata survives a
  // repository round-trip. Domain-owned keys are authoritative on collision.
  const payload = cloneObservationPayload(raw);
  for (const field of DOMAIN_PRESENCE_KEYS) {
    const presence = observation[field];
    if (presence.kind === "observed") payload[field] = presence.value;
    else delete payload[field];
  }
  // Null is explicit in the persistence payload so null and zero remain
  // distinguishable after a close/reopen round-trip.
  payload.actualPowderGrams = observation.actualPowderGrams;
  if (observation.id !== undefined) payload.id = observation.id;
  else delete payload.id;
  if (observation.recordedAt !== undefined) payload.recordedAt = observation.recordedAt;
  else delete payload.recordedAt;
  return payload;
}
