/**
 * Shared helpers for the P2-4 legacy JSON import gate.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runNaibajiMigrations } from "@naibaji/persistence/migrations";
import { createImportPersistence } from "../../src/import/sqlite-adapters.js";
import type { ImportPersistencePort } from "../../src/import/contracts.js";

export const FIXTURE_ROOT = resolve(import.meta.dirname, "../fixtures/p2-4");

export interface FixtureManifestEntry {
  readonly fixture: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly constructedFrom?: string;
  readonly transformation?: string;
  readonly purpose?: string;
}

export interface FixtureManifest {
  readonly formatVersion: number;
  readonly baseRealFixture: {
    readonly fixture: string;
    readonly sha256: string;
    readonly byteSize: number;
    readonly rawSourceSha256: string;
    readonly rawSourceByteSize: number;
    readonly sourceOrigin: {
      readonly kind: string;
      readonly path: string;
      readonly capturedPurpose: string;
      readonly capturedDate: string;
    };
    readonly observedSourceState: string;
    readonly sanitizationRecord: {
      readonly secretsPresent: boolean;
      readonly personalDataPresent: boolean;
      readonly liveEndpointsPresent: boolean;
      readonly deviceControlAuthorityPresent: boolean;
    };
  };
  readonly variants: FixtureManifestEntry[];
  readonly ownerMappings: FixtureManifestEntry[];
}

export function loadFixtureManifest(): FixtureManifest {
  return JSON.parse(
    readFileSync(join(FIXTURE_ROOT, "p2-4-import-fixtures.manifest.json"), "utf8"),
  ) as FixtureManifest;
}

export function fixturePath(name: string): string {
  return join(FIXTURE_ROOT, name);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fixtureSha256(manifest: FixtureManifest, name: string): string {
  if (manifest.baseRealFixture.fixture === name) return manifest.baseRealFixture.sha256;
  const variant = manifest.variants.find((entry) => entry.fixture === name);
  if (!variant) throw new Error("fixture not in manifest: " + name);
  return variant.sha256;
}

export interface ImportTestContext {
  readonly dir: string;
  readonly dbPath: string;
  readonly database: DatabaseSync;
  readonly persistence: ImportPersistencePort;
  cleanup(): void;
}

export function createImportTestContext(): ImportTestContext {
  const dir = mkdtempSync(join(tmpdir(), "nbj-p2-4-"));
  const dbPath = join(dir, "dest.db");
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA foreign_keys = ON;");
  runNaibajiMigrations({ database });
  database
    .prepare("INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'admin', ?)")
    .run("fixture-user", "fixture-user@example.invalid", "2026-08-01T00:00:00.000Z");
  const persistence = createImportPersistence(database, dbPath);
  let closed = false;
  return {
    dir,
    dbPath,
    database,
    persistence,
    cleanup() {
      if (!closed) {
        try {
          database.close();
        } catch {
          // already closed
        }
        closed = true;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface WrittenMapping {
  readonly path: string;
  readonly sha256: string;
}

export function writeOwnerMapping(
  dir: string,
  sourceSha256: string,
  targetUserId = "fixture-user",
  suffix = "",
): WrittenMapping {
  const mapping = {
    formatVersion: 1,
    sourceKind: "json-database-v1",
    sourceSha256,
    targetUserId,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const path = join(dir, "mapping" + suffix + ".json");
  writeFileSync(path, JSON.stringify(mapping, null, 2));
  return { path, sha256: sha256File(path) };
}

export function rowCount(database: DatabaseSync, table: string): number {
  return Number(database.prepare("SELECT COUNT(*) AS n FROM " + table).get()?.n ?? 0);
}
