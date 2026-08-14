/**
 * P2-4 owner-mapping manifest handling (contract 6, 6.1). The mapping is
 * hash-bound to the import run: accepted source identity is
 * (source_kind, source_sha256); the accepted owner mapping is
 * owner_mapping_sha256 bound to that source/import result.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { OwnerMappingManifest } from "./contracts.js";

export class OwnerMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerMappingError";
  }
}

export interface LoadedOwnerMapping {
  readonly manifest: OwnerMappingManifest;
  readonly sha256: string;
  readonly byteLength: number;
}

const SHA_HEX = /^[a-f0-9]{64}$/;

export function loadOwnerMapping(path: string): LoadedOwnerMapping {
  const bytes = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new OwnerMappingError("invalid-owner-mapping: " + (error as Error).message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OwnerMappingError("invalid-owner-mapping: manifest must be an object");
  }
  const manifest = parsed as OwnerMappingManifest;
  if (manifest.formatVersion !== 1) {
    throw new OwnerMappingError("invalid-owner-mapping: formatVersion must be 1");
  }
  if (typeof manifest.sourceKind !== "string" || manifest.sourceKind.length === 0) {
    throw new OwnerMappingError("invalid-owner-mapping: sourceKind is required");
  }
  if (typeof manifest.sourceSha256 !== "string" || !SHA_HEX.test(manifest.sourceSha256)) {
    throw new OwnerMappingError("invalid-owner-mapping: sourceSha256 must be 64 lowercase hex chars");
  }
  if (typeof manifest.targetUserId !== "string" || manifest.targetUserId.length === 0) {
    throw new OwnerMappingError("invalid-owner-mapping: targetUserId is required");
  }
  return {
    manifest,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}
