import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { INITIAL_SCHEMA } from "../../src/local-db/schema.js";

interface SchemaDdlEvent {
  actionCode: number;
  objectName: string | null;
  auxiliaryName: string | null;
  databaseName: string | null;
}

const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createMigratedFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-p2-3b-ownership-"));
  cleanupDirectories.push(directory);
  const filename = join(directory, "agent.sqlite");
  const store = createLocalStore({ filename });
  store.migrate();
  store.close();
  return filename;
}

function digestRows(database: DatabaseSync, sql: string): string {
  return createHash("sha256")
    .update(JSON.stringify(database.prepare(sql).all()).normalize("NFC"), "utf8")
    .digest("hex")
    .toUpperCase();
}

function databaseDigests(filename: string): {
  ledger: string;
  schema: string;
  business: string;
} {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      ledger: digestRows(database, `
        SELECT version, name, checksum, application_version, applied_at
        FROM schema_migrations ORDER BY version
      `),
      schema: digestRows(database, `
        SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
      `),
      business: digestRows(database, `
        SELECT 'users' AS source, COUNT(*) AS count FROM users
        UNION ALL SELECT 'batches', COUNT(*) FROM batches
        UNION ALL SELECT 'daily_observations', COUNT(*) FROM daily_observations
        UNION ALL SELECT 'agent_messages', COUNT(*) FROM agent_messages
        ORDER BY source
      `),
    };
  } finally {
    database.close();
  }
}

function expectTamperBeforeDdl(column: "name" | "checksum", value: string, message: string): void {
  const filename = createMigratedFile();
  const database = new DatabaseSync(filename);
  database.prepare(`UPDATE schema_migrations SET ${column} = ? WHERE version = 12`).run(value);
  database.close();
  const before = databaseDigests(filename);
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
  expect(databaseDigests(filename)).toEqual(before);
}

describe("P2-3B migration ownership", () => {
  it("keeps the sealed v12 identity and registers one forward v13 repair", () => {
    const noOp = () => undefined;
    const database = new DatabaseSync(":memory:");
    try {
      const chain = defineNaibajiMigrationChain(database);
      expect(chain.map(({ version, name }) => ({ version, name }))).toEqual([
        { version: 12, name: SEALED_V12_NAME },
        { version: 13, name: "registered-schema-v13-repair" },
      ]);
      expect(chain[0]?.checksum).toBe(SEALED_V12_CHECKSUM);
      expect(SEALED_V12_CHECKSUM).toBe(
        "0B204D099EA0661A836F2F0DD34207A6CEF3B0C79C2FE86263F40FD381F4068E",
      );
      expect(CURRENT_MIGRATION_VERSION).toBe(13);
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

  it("executes zero schema DDL on a zero-pending restart and preserves all digests", () => {
    const filename = createMigratedFile();
    const before = databaseDigests(filename);
    const ddlEvents: SchemaDdlEvent[] = [];
    const store = createLocalStore({
      filename,
      onSchemaDdl: (event) => ddlEvents.push(event),
    });
    store.migrate();
    store.close();
    expect(ddlEvents).toEqual([]);
    expect(databaseDigests(filename)).toEqual(before);
  });

  it("fails a persisted checksum tamper before schema DDL or digest changes", () => {
    expectTamperBeforeDdl("checksum", "0".repeat(64), "migration checksum mismatch at version 12");
  });

  it("fails a persisted name tamper before schema DDL or digest changes", () => {
    expectTamperBeforeDdl("name", "renamed-v12", "migration name mismatch at version 12");
  });
});
