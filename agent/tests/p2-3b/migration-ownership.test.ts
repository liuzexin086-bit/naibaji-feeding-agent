import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATION_VERSION,
  SEALED_V12_CHECKSUM,
  SEALED_V12_NAME,
  defineNaibajiMigrationChain,
} from "@naibaji/persistence/migrations";
import { createLocalStore } from "../../src/local-db/index.js";

interface FixtureManifest {
  fixture: string;
  expectedOutcome: {
    migrationVersions: number[];
    legacyArchiveVersions: number[];
  };
  expectedPostMigration: {
    ledger: Array<{
      version: number;
      name: string;
      checksum: string;
      applicationVersion: string;
    }>;
    schemaDigest: string;
    tableInventory: string[];
    indexInventory: string[];
    businessTables: string[];
    businessDigest: string;
    rawHashes: {
      batchDataJsonSha256: string;
      observationDataJsonSha256: string;
      messageContentSha256: string;
    };
  };
}

interface SchemaDdlEvent {
  actionCode: number;
  objectName: string | null;
  auxiliaryName: string | null;
  databaseName: string | null;
}

interface MigrationEvidence {
  ledger: Array<Record<string, unknown>>;
  legacyArchiveVersions: number[];
  schemaDigest: string;
  tables: string[];
  indexes: string[];
  businessTables: string[];
  businessDigest: string;
  rawHashes: FixtureManifest["expectedPostMigration"]["rawHashes"];
}

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/p2-3b");
const manifest = JSON.parse(readFileSync(
  resolve(fixtureRoot, "legacy-v5-sanitized.manifest.json"),
  "utf8",
)) as FixtureManifest;
const fixturePath = resolve(fixtureRoot, manifest.fixture);
const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function textDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").toUpperCase();
}

function digest(value: unknown): string {
  return textDigest(JSON.stringify(value));
}

function copyFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-p2-3b-ownership-"));
  cleanupDirectories.push(directory);
  const filename = join(directory, "legacy-copy.sqlite");
  copyFileSync(fixturePath, filename);
  return filename;
}

function names(database: DatabaseSync, type: "table" | "index"): string[] {
  return database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = ? AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all(type).map((row) => String(row.name));
}

function allRows(database: DatabaseSync, table: string): Array<Record<string, unknown>> {
  return database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
}

function evidence(filename: string): MigrationEvidence {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const ledger = database.prepare(`
      SELECT version, name, checksum, application_version, applied_at
      FROM schema_migrations ORDER BY version
    `).all() as Array<Record<string, unknown>>;
    const legacyArchiveVersions = database.prepare(
      "SELECT version FROM schema_migrations_legacy ORDER BY version",
    ).all().map((row) => Number(row.version));
    const schemaRows = database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `).all();
    const candidateTables = [
      "users",
      "batches",
      "daily_observations",
      "agent_sessions",
      "agent_messages",
      "audit_events",
      "sop_templates",
      "sop_knowledge_chunks",
      "sop_publication_state",
      "daily_operation_plans",
      "daily_operation_confirmations",
      "operation_results",
      "feeding_decisions",
      "daily_operation_amendments",
      "daily_operation_amendment_actions",
      "auth_sessions",
    ].sort();
    const business = candidateTables
      .map((table) => ({ table, rows: allRows(database, table) }))
      .filter((entry) => entry.rows.length > 0);
    const batchDataJson = String(database.prepare(
      "SELECT data_json FROM batches WHERE id = 'fixture-batch'",
    ).get()?.data_json ?? "");
    const observationDataJson = String(database.prepare(
      "SELECT data_json FROM daily_observations WHERE id = 'fixture-observation'",
    ).get()?.data_json ?? "");
    const messageContent = String(database.prepare(
      "SELECT content FROM agent_messages WHERE id = 'fixture-message'",
    ).get()?.content ?? "");
    return {
      ledger,
      legacyArchiveVersions,
      schemaDigest: digest(schemaRows),
      tables: names(database, "table"),
      indexes: names(database, "index"),
      businessTables: business.map((entry) => entry.table),
      businessDigest: digest(business),
      rawHashes: {
        batchDataJsonSha256: textDigest(batchDataJson),
        observationDataJsonSha256: textDigest(observationDataJson),
        messageContentSha256: textDigest(messageContent),
      },
    };
  } finally {
    database.close();
  }
}

function createMigratedFixture(): string {
  const filename = copyFixture();
  const store = createLocalStore({ filename });
  store.migrate();
  store.close();
  return filename;
}

function expectManifestEvidence(actual: MigrationEvidence): void {
  const expected = manifest.expectedPostMigration;
  expectPostMigrationLedger(actual.ledger, expected.ledger);
  expect(actual.ledger.map((row) => Number(row.version)))
    .toEqual(manifest.expectedOutcome.migrationVersions);
  expect(actual.legacyArchiveVersions)
    .toEqual(manifest.expectedOutcome.legacyArchiveVersions);
  expect(actual.schemaDigest).toBe(expected.schemaDigest);
  expect(actual.tables).toEqual(expected.tableInventory);
  expect(actual.indexes).toEqual(expected.indexInventory);
  expect(actual.businessTables).toEqual(expected.businessTables);
  expect(actual.businessDigest).toBe(expected.businessDigest);
  expect(actual.rawHashes).toEqual(expected.rawHashes);
}

function expectPostMigrationLedger(
  actual: Array<Record<string, unknown>>,
  expected: FixtureManifest["expectedPostMigration"]["ledger"],
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((row, index) => {
    const identity = expected[index];
    expect(identity).toBeDefined();
    expect(row).toMatchObject({
      version: identity?.version,
      name: identity?.name,
      checksum: identity?.checksum,
      application_version: identity?.applicationVersion,
    });
    expect(String(row.applied_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  });
}

function expectTamperBeforeDdl(column: "name" | "checksum", value: string, message: string): void {
  const filename = createMigratedFixture();
  const database = new DatabaseSync(filename);
  database.prepare(`UPDATE schema_migrations SET ${column} = ? WHERE version = 12`).run(value);
  database.close();
  const before = evidence(filename);
  const ddlEvents: SchemaDdlEvent[] = [];
  const store = createLocalStore({
    filename,
    onSchemaDdl: (event) => ddlEvents.push(event),
  });
  try {
    expect(() => store.migrate()).toThrow(message);
  } finally {
    store.close();
  }
  expect(ddlEvents).toEqual([]);
  expect(evidence(filename)).toEqual(before);
}

describe("P2-3B migration ownership", () => {
  it("keeps the sealed v12 identity and registers one forward v13 repair", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const chain = defineNaibajiMigrationChain(database);
      expect(chain.map(({ version, name }) => ({ version, name }))).toEqual([
        { version: 12, name: SEALED_V12_NAME },
        { version: 13, name: "registered-schema-v13-repair" },
        { version: 14, name: "registered-schema-v14-import" },
        { version: 15, name: "registered-schema-v15-import-evidence" },
      ]);
      expect(chain[0]?.checksum).toBe(SEALED_V12_CHECKSUM);
      expect(chain[1]?.checksum).toBe(manifest.expectedPostMigration.ledger[1]?.checksum);
      expect(SEALED_V12_CHECKSUM).toBe(
        "0B204D099EA0661A836F2F0DD34207A6CEF3B0C79C2FE86263F40FD381F4068E",
      );
      expect(CURRENT_MIGRATION_VERSION).toBe(15);
    } finally {
      database.close();
    }
  });

  it("keeps local-db migration-ledger as a compatibility re-export only", () => {
    const localLedger = readFileSync(
      resolve(import.meta.dirname, "../../src/local-db/migration-ledger.ts"),
      "utf8",
    );
    expect(localLedger).toContain('export * from "@naibaji/persistence/migrations"');
    expect(localLedger).not.toMatch(/function\s+(defineMigration|runMigrationLedger)/);
    const packageAuthority = readFileSync(
      resolve(import.meta.dirname, "../../../packages/persistence/migrations/index.js"),
      "utf8",
    );
    const localStoreSource = readFileSync(
      resolve(import.meta.dirname, "../../src/local-db/index.ts"),
      "utf8",
    );
    const structuralOperations = readFileSync(
      resolve(import.meta.dirname, "../../../packages/persistence/migrations/sqlite-operations.js"),
      "utf8",
    );
    for (const ownedOperation of [
      "defineNaibajiMigrationChain",
      "validateMigrationRegistry",
      "validateAppliedMigrations",
      "runMigrationLedger",
      "runNaibajiMigrations",
    ]) {
      expect(packageAuthority).toContain(`function ${ownedOperation}`);
    }
    expect(localStoreSource).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+(?:TABLE|INDEX)\b/i);
    expect(localStoreSource).not.toContain("applyAuditedSchemaV12Structure");
    expect(structuralOperations).toMatch(/\bCREATE TABLE\b/);
    expect(structuralOperations).toMatch(/\bALTER TABLE\b/);
  });

  it("executes zero schema DDL on a copied-fixture restart and preserves complete evidence", () => {
    const filename = createMigratedFixture();
    const before = evidence(filename);
    expectManifestEvidence(before);
    const ddlEvents: SchemaDdlEvent[] = [];
    const store = createLocalStore({
      filename,
      onSchemaDdl: (event) => ddlEvents.push(event),
    });
    store.migrate();
    store.close();
    expect(ddlEvents).toEqual([]);
    expect(evidence(filename)).toEqual(before);
  });

  it("fails a copied-fixture checksum tamper before schema DDL or evidence changes", () => {
    expectTamperBeforeDdl("checksum", "0".repeat(64), "migration checksum mismatch at version 12");
  });

  it("fails a copied-fixture name tamper before schema DDL or evidence changes", () => {
    expectTamperBeforeDdl("name", "renamed-v12", "migration name mismatch at version 12");
  });
});
