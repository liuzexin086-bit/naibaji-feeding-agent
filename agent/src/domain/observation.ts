/**
 * Framework-free observation contracts.
 *
 * `not_observed` is intentionally different from an observed value.  In
 * particular, an observed diarrhea grade of `none` is a closure signal and
 * must not be represented by omission.
 */

export type ObservationPresence<T> =
  | { readonly kind: "not_observed" }
  | { readonly kind: "observed"; readonly value: T };

export type DiarrheaGrade = "none" | "mild" | "moderate" | "severe";
export type CreepGrade = "none" | "low" | "medium" | "high" | "excellent";
export type DeviceStatus = "normal" | "blocked" | "probe_contaminated";
export type FeedingResponse = "normal" | "refusal";

export interface Observation {
  readonly id?: string;
  readonly recordedAt?: string;
  readonly diarrheaGrade: ObservationPresence<DiarrheaGrade>;
  readonly creepGrade: ObservationPresence<CreepGrade>;
  readonly deviceStatus: ObservationPresence<DeviceStatus>;
  readonly feedingResponse: ObservationPresence<FeedingResponse>;
  readonly actualPowderGrams: number | null;
}

export interface RawObservationInput {
  readonly id?: unknown;
  readonly recordedAt?: unknown;
  readonly diarrheaGrade?: unknown;
  readonly creepGrade?: unknown;
  readonly deviceStatus?: unknown;
  readonly feedingResponse?: unknown;
  readonly actualPowderGrams?: unknown;
}

const DIARRHEA = new Set<DiarrheaGrade>(["none", "mild", "moderate", "severe"]);
const CREEP = new Set<CreepGrade>(["none", "low", "medium", "high", "excellent"]);
const DEVICE = new Set<DeviceStatus>(["normal", "blocked", "probe_contaminated"]);
const FEEDING = new Set<FeedingResponse>(["normal", "refusal"]);

export function notObserved<T = never>(): ObservationPresence<T> {
  return { kind: "not_observed" };
}

export function observed<T extends string>(value: T): ObservationPresence<T> {
  if (!value.trim()) throw new Error("DOMAIN_OBSERVATION_VALUE_INVALID");
  return { kind: "observed", value };
}

function enumPresence<T extends string>(
  raw: unknown,
  allowed: ReadonlySet<T>,
): ObservationPresence<T> {
  if (raw === undefined || raw === null) return notObserved();
  if (typeof raw !== "string" || !allowed.has(raw as T)) {
    throw new Error("DOMAIN_OBSERVATION_INVALID");
  }
  return observed(raw as T);
}

function optionalString(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${name}_INVALID`);
  return raw;
}

function powder(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error("DOMAIN_OBSERVATION_INVALID");
  }
  return raw;
}

export function parseObservation(raw: unknown): Observation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("DOMAIN_OBSERVATION_INVALID");
  }
  const input = raw as RawObservationInput;
  const allowedKeys = new Set([
    "id",
    "recordedAt",
    "diarrheaGrade",
    "creepGrade",
    "deviceStatus",
    "feedingResponse",
    "actualPowderGrams",
  ]);
  if (Object.keys(input as object).some((key) => !allowedKeys.has(key))) {
    throw new Error("DOMAIN_OBSERVATION_INVALID");
  }
  const id = optionalString(input.id, "DOMAIN_OBSERVATION_ID");
  const recordedAt = optionalString(input.recordedAt, "DOMAIN_OBSERVATION_RECORDED_AT");
  return {
    ...(id === undefined ? {} : { id }),
    ...(recordedAt === undefined ? {} : { recordedAt }),
    diarrheaGrade: enumPresence(input.diarrheaGrade, DIARRHEA),
    creepGrade: enumPresence(input.creepGrade, CREEP),
    deviceStatus: enumPresence(input.deviceStatus, DEVICE),
    feedingResponse: enumPresence(input.feedingResponse, FEEDING),
    actualPowderGrams: powder(input.actualPowderGrams),
  };
}

export const normalizeObservation = parseObservation;

export function isObserved<T>(
  presence: ObservationPresence<T>,
): presence is { readonly kind: "observed"; readonly value: T } {
  return presence.kind === "observed";
}

export function observationValue<T>(
  presence: ObservationPresence<T>,
): T | undefined {
  return isObserved<T>(presence) ? presence.value : undefined;
}

export function isObservation(value: unknown): value is Observation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Observation>;
  return validPresence(candidate.diarrheaGrade, DIARRHEA) &&
    validPresence(candidate.creepGrade, CREEP) &&
    validPresence(candidate.deviceStatus, DEVICE) &&
    validPresence(candidate.feedingResponse, FEEDING) &&
    (candidate.actualPowderGrams === null ||
      (typeof candidate.actualPowderGrams === "number" &&
        Number.isFinite(candidate.actualPowderGrams) &&
        candidate.actualPowderGrams >= 0)) &&
    (candidate.id === undefined || (typeof candidate.id === "string" && Boolean(candidate.id.trim()))) &&
    (candidate.recordedAt === undefined ||
      (typeof candidate.recordedAt === "string" && Boolean(candidate.recordedAt.trim())));
}

function validPresence<T>(
  presence: unknown,
  allowed: ReadonlySet<T>,
): presence is ObservationPresence<T> {
  if (!presence || typeof presence !== "object" || Array.isArray(presence)) return false;
  const candidate = presence as { kind?: unknown; value?: unknown };
  if (candidate.kind === "not_observed") {
    return !Object.prototype.hasOwnProperty.call(candidate, "value");
  }
  return candidate.kind === "observed" && allowed.has(candidate.value as T);
}
