/**
 * P2-4 read-only JSON Database v1 source adapter (contract 3, 4, 13).
 *
 * The source file is never modified: it is read, byte-hashed, and parsed.
 * Duplicate object keys are detected per row: a row with duplicate keys is
 * not canonically serializable and is quarantined by the importer (contract
 * 5.1); duplicate keys outside a collection row (envelope, meta, unknown
 * top-level structure) make the whole source malformed and fail closed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseJsonWithDuplicatePaths } from "./canonical-json.js";
import { JSON_V1_COLLECTIONS } from "./contracts.js";

export class SourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceReadError";
  }
}

export interface DuplicateKeyRowEvidence {
  readonly collection: string;
  readonly ordinal: number;
  /** The ORIGINAL source row text slice, including the duplicate keys. */
  readonly rawText: string;
  readonly rawSha256: string;
  readonly byteLength: number;
  /**
   * True iff the source record's id field itself is duplicated, i.e. a
   * duplicate key at the exact top-level path
   * $["<collection>"]["<ordinal>"]["id"] (contract 5.2 Rule 2). A nested
   * duplicate key also named "id" does NOT touch the top-level id, so it
   * leaves this false (Rule 1 keeps the provable record_identity).
   */
  readonly sourceIdFieldDuplicated: boolean;
}

export interface UnknownTopLevelValue {
  readonly key: string;
  /** The ORIGINAL source value text slice for the unknown top-level key. */
  readonly rawText: string;
  readonly rawSha256: string;
  readonly byteLength: number;
  readonly value: unknown;
}

export interface JsonV1Source {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly parsed: Record<string, unknown>;
  readonly collections: Record<string, unknown[]>;
  readonly schemaVersion: number;
  readonly unknownTopLevelKeys: string[];
  /** Rows containing duplicate keys, with lossless original row slices. */
  readonly duplicateKeyRows: readonly DuplicateKeyRowEvidence[];
  /** Unknown top-level keys with their losslessly preserved values. */
  readonly unknownTopLevelValues: readonly UnknownTopLevelValue[];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rowKeyOf(duplicatePath: string): string | null {
  const match = /^\$\["([^"]+)"\]\[(\d+)\](?:\[|$)/.exec(duplicatePath);
  if (!match) return null;
  const collection = match[1] as string;
  if (!(JSON_V1_COLLECTIONS as readonly string[]).includes(collection)) return null;
  return collection + "[" + match[2] + "]";
}

export function readJsonV1Source(path: string): JsonV1Source {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  let parsed: unknown;
  let duplicatePaths: readonly string[] = [];
  let spans: ReadonlyMap<string, import("./canonical-json.js").ValueSpan> = new Map();
  try {
    const result = parseJsonWithDuplicatePaths(text);
    parsed = result.value;
    duplicatePaths = result.duplicatePaths;
    spans = result.spans;
  } catch (error) {
    throw new SourceReadError("malformed-json: " + (error as Error).message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SourceReadError("invalid-envelope: top-level value must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const meta = record.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new SourceReadError("invalid-envelope: meta is missing or not an object");
  }
  const schemaVersion = (meta as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== 1) {
    throw new SourceReadError(
      "unsupported-schema: schemaVersion " + String(schemaVersion) + " (only 1 is accepted)",
    );
  }
  const collections: Record<string, unknown[]> = {};
  for (const name of JSON_V1_COLLECTIONS) {
    const value = record[name];
    if (!Array.isArray(value)) {
      throw new SourceReadError("invalid-envelope: collection " + name + " is not an array");
    }
    collections[name] = value;
  }
  const unknownTopLevelKeys = Object.keys(record).filter(
    (key) => key !== "meta" && !(JSON_V1_COLLECTIONS as readonly string[]).includes(key),
  );
  // duplicate keys inside a collection row are quarantined per row; any
  // other duplicate (envelope, meta, or unknown top-level structure) makes
  // the source non-canonically serializable and fails closed
  const duplicateKeyRowKeys = new Set<string>();
  // contract 5.2 Rule 2 fires only when the duplicated key is the source
  // record's own id field: the exact top-level path
  // $["<collection>"]["<ordinal>"]["id"]. A nested duplicate key also
  // named "id" is a different path and does NOT count.
  const duplicatedSourceIdRows = new Set<string>();
  for (const duplicatePath of duplicatePaths) {
    const rowKey = rowKeyOf(duplicatePath);
    if (rowKey !== null) {
      duplicateKeyRowKeys.add(rowKey);
      // the canonical id-field path is $["<collection>"]["<ordinal>"]["id"];
      // rowKey is <collection>[<ordinal>] so rebuild the quoted form
      const rk = /^(.*?)\[(\d+)\]$/.exec(rowKey);
      if (
        rk &&
        duplicatePath === '$["' + rk[1] + '"][' + rk[2] + ']["id"]'
      ) {
        duplicatedSourceIdRows.add(rowKey);
      }
    } else {
      throw new SourceReadError("malformed-json: duplicate key outside collection rows at " + duplicatePath);
    }
  }
  const duplicateKeyRows: DuplicateKeyRowEvidence[] = [];
  for (const rowKey of [...duplicateKeyRowKeys].sort()) {
    const match = /^(.*?)\[(\d+)\]$/.exec(rowKey);
    if (!match) continue;
    const collection = match[1] as string;
    const ordinal = Number(match[2]);
    const span = spans.get('$["' + collection + '"][' + ordinal + "]");
    if (!span) {
      throw new SourceReadError("malformed-json: missing span for duplicate-key row " + rowKey);
    }
    const rawText = text.slice(span.start, span.end);
    duplicateKeyRows.push({
      collection,
      ordinal,
      rawText,
      rawSha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(rawText, "utf8"),
      sourceIdFieldDuplicated: duplicatedSourceIdRows.has(rowKey),
    });
  }
  const unknownTopLevelValues: UnknownTopLevelValue[] = [];
  for (const key of unknownTopLevelKeys) {
    const span = spans.get('$["' + key + '"]');
    const rawText = span ? text.slice(span.start, span.end) : JSON.stringify(record[key]);
    unknownTopLevelValues.push({
      key,
      rawText,
      rawSha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(rawText, "utf8"),
      value: record[key],
    });
  }
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    parsed: record,
    collections,
    schemaVersion: 1,
    unknownTopLevelKeys,
    duplicateKeyRows,
    unknownTopLevelValues,
  };
}
