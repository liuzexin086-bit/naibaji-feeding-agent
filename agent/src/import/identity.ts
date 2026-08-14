/**
 * P2-4 frozen stable identity contract - contract 5.1.
 *
 * record_identity =
 *   SHA-256( UTF-8( CJSON([source_kind, source_sha256, collection, source_record_id]) ) )
 *
 * quarantine_identity =
 *   SHA-256( UTF-8( CJSON(["quarantine", source_kind, source_sha256, collection,
 *                        raw_row_canonical_sha256, source_ordinal]) ) )
 *
 * The quarantine identity is source-bound: different sources holding the same
 * raw row at the same ordinal receive different identities, while same-source
 * replay reproduces the identical identity.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

const SHA_HEX = /^[a-f0-9]{64}$/;

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface RecordIdentityInput {
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly collection: string;
  readonly sourceRecordId: string | number;
}

export interface QuarantineIdentityInput {
  readonly sourceKind: string;
  readonly sourceSha256: string;
  readonly collection: string;
  readonly rawRowCanonicalSha256: string;
  readonly sourceOrdinal: number;
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

function assertSourceSha256(value: string): void {
  if (!SHA_HEX.test(value)) throw new IdentityError("source_sha256 must be 64 lowercase hex chars");
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IdentityError(field + " must be a non-negative safe integer");
  }
}

/**
 * A provable source ID is a JSON string or a JSON integer in the safe-integer
 * range. Any other JSON value is not a provable source ID (contract 5.1).
 */
export function isProvableSourceId(value: unknown): value is string | number {
  if (typeof value === "string") return true;
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function rawRowCanonicalSha256(rawRow: unknown): string {
  return sha256Utf8(canonicalJson(rawRow));
}

export function recordIdentity(input: RecordIdentityInput): string {
  assertSourceSha256(input.sourceSha256);
  const serialized = canonicalJson([
    input.sourceKind,
    input.sourceSha256,
    input.collection,
    input.sourceRecordId,
  ]);
  return sha256Utf8(serialized);
}

export function quarantineIdentity(input: QuarantineIdentityInput): string {
  assertSourceSha256(input.sourceSha256);
  assertSafeInteger(input.sourceOrdinal, "source_ordinal");
  if (!SHA_HEX.test(input.rawRowCanonicalSha256)) {
    throw new IdentityError("raw_row_canonical_sha256 must be 64 lowercase hex chars");
  }
  const serialized = canonicalJson([
    "quarantine",
    input.sourceKind,
    input.sourceSha256,
    input.collection,
    input.rawRowCanonicalSha256,
    input.sourceOrdinal,
  ]);
  return sha256Utf8(serialized);
}

export interface IdentityVector {
  readonly id: string;
  readonly kind: "record" | "quarantine";
  readonly bytes: string;
  readonly hash: string;
  readonly note: string;
}

/**
 * Frozen known hash vectors (contract 5.1, gate 14.1). The gate recomputes
 * every vector from this module and must match these committed values.
 */
export const V1_SOURCE_KIND = "json-database-v1";
export const V1_SOURCE_SHA256 =
  "3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c";
export const V6_SOURCE_SHA256 =
  "6653b072ca9d89fec4eaa7e88a06bcaa6860b6ad3fd7d01020b57e0cd5b12e47";

function vector(
  id: string,
  bytes: string,
  hash: string,
  kind: IdentityVector["kind"],
  note: string,
): IdentityVector {
  return { id, bytes, hash, kind, note };
}

const V1_BYTES =
  '["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","legacy-2026-08-01-001"]';
const V2_BYTES =
  '["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords",42]';
const V3_BYTES =
  '["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","café"]';
const V4A_BYTES =
  '["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","ab","c"]';
const V4B_BYTES =
  '["json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","a","bc"]';
const V5_RAW_ROW = { qty: 2.5, note: "乳量", id: "r-9" };
const V5_RAW_ROW_SHA = rawRowCanonicalSha256(V5_RAW_ROW);
const V5_BYTES =
  '["quarantine","json-database-v1","3b5d5c3712955042212316173ccf37bea9d0f9b1c1e2c3d4e5f60718293a4b5c","dailyRecords","' +
  V5_RAW_ROW_SHA +
  '",3]';
const V6_BYTES =
  '["quarantine","json-database-v1","6653b072ca9d89fec4eaa7e88a06bcaa6860b6ad3fd7d01020b57e0cd5b12e47","dailyRecords","' +
  V5_RAW_ROW_SHA +
  '",3]';

export const KNOWN_IDENTITY_VECTORS: readonly IdentityVector[] = [
  vector(
    "V1",
    V1_BYTES,
    "9820db706590270d8b714764407de8d89afbddb4ed4fb95ca4973ce5d48c1e24",
    "record",
    "string source_record_id",
  ),
  vector(
    "V2",
    V2_BYTES,
    "9b82659f32505dd4e0179d405f268c55f2310a651da96ecaeb03ea482abccbe8",
    "record",
    "integer source_record_id",
  ),
  vector(
    "V3",
    V3_BYTES,
    "b25bfe4da3293e2e87bfa33633a34c59ac9f0e288679cc189f3729f6b95d0a32",
    "record",
    "NFC normalization: input cafe + combining acute equals composed cafe",
  ),
  vector(
    "V4a",
    V4A_BYTES,
    "2c73d6acbae7f036f6332b81887d790bd93ed79e06c9c7082a521fcb4119944a",
    "record",
    "tuple boundary: collection=ab, id=c",
  ),
  vector(
    "V4b",
    V4B_BYTES,
    "d60212cc53f784f272b5271ab57a73e2ca3f08b77621eb262d7afcad7429a8b1",
    "record",
    "tuple boundary: collection=a, id=bc; must differ from V4a",
  ),
  vector(
    "V5",
    V5_BYTES,
    "e336926640a38fcc5061f098f708e6bad82a2c88da51bcca83ef0755549e4f33",
    "quarantine",
    "source-bound quarantine identity for source A",
  ),
  vector(
    "V6",
    V6_BYTES,
    "6c55d8371e3befe0e3684662e94cc77bad4a932cd89ccac0df3302fed5cb5f0e",
    "quarantine",
    "cross-source separation: same row/collection/ordinal, different source_sha256; must differ from V5",
  ),
];

export function assertKnownVectors(): void {
  for (const candidate of KNOWN_IDENTITY_VECTORS) {
    const actual = sha256Utf8(candidate.bytes);
    if (actual !== candidate.hash) {
      throw new IdentityError(
        "identity vector " + candidate.id + " drifted: expected " + candidate.hash + " got " + actual,
      );
    }
  }
}
