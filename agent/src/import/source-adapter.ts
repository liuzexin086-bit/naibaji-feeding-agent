/**
 * P2-4 read-only JSON Database v1 source adapter (contract 3, 4, 13).
 * The source file is never modified: it is read, byte-hashed, and parsed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseStrictJson, CanonicalJsonError } from "./canonical-json.js";
import { JSON_V1_COLLECTIONS } from "./contracts.js";

export class SourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceReadError";
  }
}

export interface JsonV1Source {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly parsed: Record<string, unknown>;
  readonly collections: Record<string, unknown[]>;
  readonly schemaVersion: number;
  readonly unknownTopLevelKeys: string[];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readJsonV1Source(path: string): JsonV1Source {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new SourceReadError("malformed-json: " + error.message);
    }
    throw error;
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
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    parsed: record,
    collections,
    schemaVersion: 1,
    unknownTopLevelKeys,
  };
}
