import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AGENT_APPLICATION_VERSION,
  LEGACY_APPLICATION_VERSION,
  applyPendingMigrations,
  defineMigration,
  migrationChecksum,
  prepareMigrationLedger,
  runMigrationLedger,
  validateAppliedMigrations,
  validateMigrationRegistry,
  type AppliedMigrationRow,
  type MigrationDefinition,
} from "../../src/local-db/migration-ledger.js";

function migration(
  version: number,
  name: string,
  apply: () => void = () => undefined,
): MigrationDefinition {
  return defineMigration({
    version,
    name,
    canonicalBody: `operation=${name}\nversion=${version}`,
    apply,
  });
}

function richRows(database: DatabaseSync): Array<Record<string, unknown>> {
  return database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
}

describe("ordered migration ledger", () => {
  it("canonicalizes line endings and NFC before hashing", () => {
    const composed = migrationChecksum({
      version: 12,
      name: "schéma",
      canonicalBody: "first\r\nsecond",
    });
    const decomposed = migrationChecksum({
      version: 12,
      name: "sche\u0301ma",
      canonicalBody: "first\nsecond",
    });
    expect(composed).toBe(decomposed);
    expect(composed).toMatch(/^[A-F0-9]{64}$/);
  });

  it("embeds the Agent package version without a runtime package file dependency", () => {
    const packageJson = JSON.parse(readFileSync(
      resolve(import.meta.dirname, "../../package.json"),
      "utf8",
    )) as { version: string };
    expect(AGENT_APPLICATION_VERSION).toBe(packageJson.version);
  });

  it("rejects duplicate and out-of-order registry definitions before database mutation", () => {
    const database = new DatabaseSync(":memory:");
    const first = migration(12, "baseline");
    const duplicate = migration(12, "duplicate");
    expect(() => runMigrationLedger({
      database,
      migrations: [first, duplicate],
      applicationVersion: "test-app",
    })).toThrow("not strictly ordered");
    expect(database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get()).toBeUndefined();
    expect(() => validateMigrationRegistry([migration(13, "later"), first]))
      .toThrow("not strictly ordered");
    database.close();
  });

  it("requires applied rows to be an exact registered prefix before later apply", () => {
    let laterApplied = false;
    const first = migration(12, "baseline");
    const later = migration(13, "later", () => { laterApplied = true; });
    const valid: AppliedMigrationRow = {
      version: first.version,
      name: first.name,
      checksum: first.checksum,
      applicationVersion: "first-app",
      appliedAt: "2026-08-13T00:00:00.000Z",
    };
    for (const row of [
      { ...valid, version: 13 },
      { ...valid, name: "renamed" },
      { ...valid, checksum: "0".repeat(64) },
    ]) {
      const database = new DatabaseSync(":memory:");
      try {
        expect(() => applyPendingMigrations({
          database,
          migrations: [first, later],
          appliedRows: [row],
          applicationVersion: "second-app",
        })).toThrow();
      } finally {
        database.close();
      }
      expect(laterApplied).toBe(false);
    }
    expect(() => validateAppliedMigrations([first, later], [
      valid,
      {
        version: 99,
        name: "unknown",
        checksum: "A".repeat(64),
        applicationVersion: "unknown-app",
        appliedAt: "2026-08-13T00:00:01.000Z",
      },
    ])).toThrow("exact registered prefix");
  });

  it("applies a fresh chain in order and preserves first-applier identity on rerun", () => {
    const database = new DatabaseSync(":memory:");
    const applied: number[] = [];
    const migrations = [
      migration(12, "baseline", () => applied.push(12)),
      migration(13, "later", () => applied.push(13)),
    ];
    let tick = 0;
    runMigrationLedger({
      database,
      migrations,
      applicationVersion: "first-app",
      now: () => `2026-08-13T00:00:0${tick++}.000Z`,
    });
    runMigrationLedger({
      database,
      migrations,
      applicationVersion: "second-app",
      now: () => "2099-01-01T00:00:00.000Z",
    });
    expect(applied).toEqual([12, 13]);
    expect(richRows(database)).toMatchObject([
      { version: 12, application_version: "first-app", applied_at: "2026-08-13T00:00:00.000Z" },
      { version: 13, application_version: "first-app", applied_at: "2026-08-13T00:00:01.000Z" },
    ]);
    database.close();
  });

  it("fails closed on a tampered persisted checksum before a later migration runs", () => {
    const database = new DatabaseSync(":memory:");
    const baseline = migration(12, "baseline");
    runMigrationLedger({
      database,
      migrations: [baseline],
      applicationVersion: "first-app",
    });
    database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 12")
      .run("0".repeat(64));

    let laterApplied = false;
    const later = migration(13, "later", () => { laterApplied = true; });
    expect(() => runMigrationLedger({
      database,
      migrations: [baseline, later],
      applicationVersion: "second-app",
    })).toThrow("migration checksum mismatch at version 12");
    expect(laterApplied).toBe(false);
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual([{ version: 12 }]);
    database.close();
  });

  it("imports an old v12 ledger losslessly without rerunning the baseline", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (7, '2026-08-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (12, '2026-08-08T00:00:00.000Z');
    `);
    let applyCount = 0;
    const baseline = migration(12, "baseline", () => { applyCount += 1; });
    runMigrationLedger({
      database,
      migrations: [baseline],
      applicationVersion: "new-app",
    });
    expect(applyCount).toBe(0);
    expect(database.prepare(
      "SELECT version, applied_at FROM schema_migrations_legacy ORDER BY version",
    ).all()).toEqual([
      { version: 7, applied_at: "2026-08-01T00:00:00.000Z" },
      { version: 12, applied_at: "2026-08-08T00:00:00.000Z" },
    ]);
    expect(richRows(database)).toMatchObject([{
      version: 12,
      name: baseline.name,
      checksum: baseline.checksum,
      application_version: LEGACY_APPLICATION_VERSION,
      applied_at: "2026-08-08T00:00:00.000Z",
    }]);
    database.close();
  });

  it("archives an N-1 ledger and applies only the audited baseline", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (11, '2026-08-08T00:00:00.000Z');
    `);
    let applyCount = 0;
    const baseline = migration(12, "baseline", () => { applyCount += 1; });
    runMigrationLedger({
      database,
      migrations: [baseline],
      applicationVersion: "new-app",
      now: () => "2026-08-13T00:00:00.000Z",
    });
    expect(applyCount).toBe(1);
    expect(database.prepare("SELECT * FROM schema_migrations_legacy").all())
      .toEqual([{ version: 11, applied_at: "2026-08-08T00:00:00.000Z" }]);
    expect(richRows(database)).toMatchObject([{
      version: 12,
      application_version: "new-app",
    }]);
    database.close();
  });

  it("rolls back migration effects and the ledger row together", () => {
    const database = new DatabaseSync(":memory:");
    const baseline = migration(12, "baseline", () => {
      database.exec("CREATE TABLE rollback_marker (id INTEGER PRIMARY KEY) STRICT;");
      throw new Error("injected migration failure");
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      runMigrationLedger({
        database,
        migrations: [baseline],
        applicationVersion: "test-app",
      });
      throw new Error("expected migration to fail");
    } catch (error) {
      database.exec("ROLLBACK");
      expect(error).toMatchObject({ message: "injected migration failure" });
    }
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('schema_migrations', 'rollback_marker')
    `).all()).toEqual([]);
    database.close();
  });

  it("treats applied_at as audit metadata rather than migration identity", () => {
    const database = new DatabaseSync(":memory:");
    const baseline = migration(12, "baseline");
    const rows = prepareMigrationLedger(database, baseline);
    applyPendingMigrations({
      database,
      migrations: [baseline],
      appliedRows: rows,
      applicationVersion: "test-app",
      now: () => "2026-08-13T00:00:00.000Z",
    });
    database.prepare("UPDATE schema_migrations SET applied_at = ? WHERE version = 12")
      .run("2099-12-31T23:59:59.000Z");
    expect(() => runMigrationLedger({
      database,
      migrations: [baseline],
      applicationVersion: "other-app",
    })).not.toThrow();
    database.close();
  });
});
