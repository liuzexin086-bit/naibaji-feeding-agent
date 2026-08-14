import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, constants as sqliteConstants } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATION_VERSION,
  SEALED_V12_CHECKSUM,
  SEALED_V12_NAME,
  SEALED_V14_NAME,
  SEALED_V15_CHECKSUM,
  SEALED_V15_NAME,
  SEALED_V16_CHECKSUM,
  SEALED_V16_NAME,
  defineNaibajiMigrationChain,
  runNaibajiMigrations,
} from "@naibaji/persistence/migrations";

interface SchemaDdlEvent {
  actionCode: number;
  objectName: string | null;
}

const IMPORT_TABLES = ["import_manifests", "import_record_traces", "import_quarantine"];

function names(database: DatabaseSync, type: "table" | "index"): string[] {
  return database
    .prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all(type)
    .map((row) => String(row.name));
}

describe("P2-4 v14 import schema migration", () => {
  it("registers v14 as the forward migration identity while v12 stays sealed", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const chain = defineNaibajiMigrationChain(database);
      expect(chain.map(({ version, name }) => ({ version, name }))).toEqual([
        { version: 12, name: SEALED_V12_NAME },
        { version: 13, name: "registered-schema-v13-repair" },
        { version: 14, name: SEALED_V14_NAME },
        { version: 15, name: SEALED_V15_NAME },
        { version: 16, name: SEALED_V16_NAME },
      ]);
      expect(chain[0]?.checksum).toBe(SEALED_V12_CHECKSUM);
      // published identities stay immutable: v14, v15 and v16 are pinned exactly,
      // independently of CURRENT_MIGRATION_VERSION
      expect(chain[2]?.checksum).toBe("0711127CBEA84AC5D2E07145D535A1BE011176CAF893C8096F498B8FD2C94C33");
      expect(chain[3]?.checksum).toBe(SEALED_V15_CHECKSUM);
      expect(chain[4]?.checksum).toBe(SEALED_V16_CHECKSUM);
      expect(chain[4]?.checksum).toBe("F79E3F38925EDAF819D7D9CEF19DF36E02FF9BD8258C8BFA980DA6FC5014366D");
      expect(CURRENT_MIGRATION_VERSION).toBe(16);
    } finally {
      database.close();
    }
  });

  it("creates the import tables through the canonical runner with a single ledger row", () => {
    const directory = mkdtempSync(join(tmpdir(), "nbj-p2-4-migrate-"));
    try {
      const path = join(directory, "migrated.db");
      const database = new DatabaseSync(path);
      try {
        runNaibajiMigrations({ database });
        const ledger = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
        expect(ledger.map((row) => Number(row.version))).toEqual([12, 13, 14, 15, 16]);
        expect(ledger[2]).toMatchObject({ version: 14, name: SEALED_V14_NAME });
        expect(ledger[3]).toMatchObject({ version: 15, name: SEALED_V15_NAME });
        expect(ledger[4]).toMatchObject({ version: 16, name: SEALED_V16_NAME });
        const tables = names(database, "table");
        for (const table of IMPORT_TABLES) expect(tables).toContain(table);
        expect(tables).toContain("import_backup_evidence");
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("executes zero schema DDL on a zero-pending restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "nbj-p2-4-zeroddl-"));
    try {
      const path = join(directory, "restart.db");
      const first = new DatabaseSync(path);
      runNaibajiMigrations({ database: first });
      first.close();
      const schemaActions = new Set([
        sqliteConstants.SQLITE_CREATE_INDEX,
        sqliteConstants.SQLITE_CREATE_TABLE,
        sqliteConstants.SQLITE_CREATE_TEMP_INDEX,
        sqliteConstants.SQLITE_CREATE_TEMP_TABLE,
        sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER,
        sqliteConstants.SQLITE_CREATE_TEMP_VIEW,
        sqliteConstants.SQLITE_CREATE_TRIGGER,
        sqliteConstants.SQLITE_CREATE_VIEW,
        sqliteConstants.SQLITE_DROP_INDEX,
        sqliteConstants.SQLITE_DROP_TABLE,
        sqliteConstants.SQLITE_DROP_TEMP_INDEX,
        sqliteConstants.SQLITE_DROP_TEMP_TABLE,
        sqliteConstants.SQLITE_DROP_TEMP_TRIGGER,
        sqliteConstants.SQLITE_DROP_TEMP_VIEW,
        sqliteConstants.SQLITE_DROP_TRIGGER,
        sqliteConstants.SQLITE_DROP_VIEW,
        sqliteConstants.SQLITE_ALTER_TABLE,
        sqliteConstants.SQLITE_CREATE_VTABLE,
        sqliteConstants.SQLITE_DROP_VTABLE,
      ]);
      const ddlEvents: SchemaDdlEvent[] = [];
      const second = new DatabaseSync(path);
      second.setAuthorizer((actionCode, objectName) => {
        if (schemaActions.has(actionCode)) ddlEvents.push({ actionCode, objectName });
        return sqliteConstants.SQLITE_OK;
      });
      try {
        runNaibajiMigrations({ database: second });
      } finally {
        second.close();
      }
      expect(ddlEvents).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps zero schema DDL in every import runtime module", () => {
    const importRoot = resolve(import.meta.dirname, "../../src/import");
    const files = readdirSync(importRoot).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const ddlPattern = /\b(?:CREATE|DROP|ALTER)\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b|\bIF NOT EXISTS\b|\bCREATE\s+UNIQUE\s+INDEX\b/i;
    for (const file of files) {
      const source = readFileSync(join(importRoot, file), "utf8");
      expect(ddlPattern.test(source), file).toBe(false);
    }
  });
});
