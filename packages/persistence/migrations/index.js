import { createHash } from "node:crypto";
import { INITIAL_SCHEMA } from "./schema.js";
import {
  applyAuditedSchemaV12Structure,
  backfillLegacyFrozenSnapshots,
  preflightDuplicateActiveDecisions,
} from "./sqlite-operations.js";

export const AGENT_APPLICATION_VERSION = "0.1.0";
export const LEGACY_APPLICATION_VERSION = "legacy-unknown";
export const SEALED_V12_NAME = "audited-schema-v12-baseline";
export const SEALED_V12_CHECKSUM =
  "0B204D099EA0661A836F2F0DD34207A6CEF3B0C79C2FE86263F40FD381F4068E";
export const CURRENT_MIGRATION_VERSION = 13;

const LEDGER_COLUMNS = [
  "version",
  "name",
  "checksum",
  "application_version",
  "applied_at",
];
const LEGACY_LEDGER_COLUMNS = ["version", "applied_at"];

const MIGRATION_LEDGER_SCHEMA = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  application_version TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

function normalizeCanonicalBody(value) {
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

export function migrationChecksum(input) {
  const canonical = JSON.stringify({
    version: input.version,
    name: input.name.normalize("NFC"),
    body: normalizeCanonicalBody(input.canonicalBody),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex").toUpperCase();
}

export function defineMigration(input) {
  return Object.freeze({
    ...input,
    name: input.name.normalize("NFC"),
    canonicalBody: normalizeCanonicalBody(input.canonicalBody),
    checksum: migrationChecksum(input),
  });
}

export function validateMigrationRegistry(migrations) {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`migration version must be a positive safe integer: ${migration.version}`);
    }
    if (migration.version <= previous) {
      throw new Error(`migration registry is not strictly ordered at version ${migration.version}`);
    }
    if (migration.name.length === 0) {
      throw new Error(`migration name must be non-empty at version ${migration.version}`);
    }
    const expectedChecksum = migrationChecksum(migration);
    if (migration.checksum !== expectedChecksum) {
      throw new Error(`migration checksum definition mismatch at version ${migration.version}`);
    }
    previous = migration.version;
  }
}

export function validateAppliedMigrations(migrations, appliedRows) {
  validateMigrationRegistry(migrations);
  if (appliedRows.length > migrations.length) {
    throw new Error("migration ledger contains more rows than the registered migration chain");
  }
  for (let index = 0; index < appliedRows.length; index += 1) {
    const applied = appliedRows[index];
    const registered = migrations[index];
    if (applied.version !== registered.version) {
      throw new Error(`migration ledger is not an exact registered prefix at version ${applied.version}`);
    }
    if (applied.name !== registered.name) {
      throw new Error(`migration name mismatch at version ${applied.version}`);
    }
    if (applied.checksum !== registered.checksum) {
      throw new Error(`migration checksum mismatch at version ${applied.version}`);
    }
    if (applied.applicationVersion.length === 0 || applied.appliedAt.length === 0) {
      throw new Error(`migration audit metadata is incomplete at version ${applied.version}`);
    }
  }
}

function tableColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all()
    .map((row) => String(row.name));
}

function sameColumns(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function readAppliedRows(database) {
  return database.prepare(`
    SELECT version, name, checksum, application_version, applied_at
    FROM schema_migrations
    ORDER BY version ASC
  `).all().map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    applicationVersion: String(row.application_version),
    appliedAt: String(row.applied_at),
  }));
}

export function prepareMigrationLedger(database, baseline) {
  const columns = tableColumns(database, "schema_migrations");
  if (columns.length === 0) {
    database.exec(MIGRATION_LEDGER_SCHEMA);
    return [];
  }
  if (sameColumns(columns, LEDGER_COLUMNS)) return readAppliedRows(database);
  if (!sameColumns(columns, LEGACY_LEDGER_COLUMNS)) {
    throw new Error(`schema_migrations has unsupported columns: ${columns.join(",")}`);
  }
  if (tableColumns(database, "schema_migrations_legacy").length > 0) {
    throw new Error("schema_migrations_legacy already exists during ledger upgrade");
  }

  const legacyRows = database.prepare(`
    SELECT version, applied_at FROM schema_migrations ORDER BY version ASC
  `).all();
  const versions = legacyRows.map((row) => Number(row.version));
  if (versions.some((version) => !Number.isSafeInteger(version) || version <= 0)) {
    throw new Error("legacy migration ledger contains an invalid version");
  }
  if (versions.some((version) => version > baseline.version)) {
    throw new Error("legacy migration ledger is newer than the registered baseline");
  }

  database.exec("ALTER TABLE schema_migrations RENAME TO schema_migrations_legacy;");
  database.exec(MIGRATION_LEDGER_SCHEMA);
  const baselineRow = legacyRows.find((row) => Number(row.version) === baseline.version);
  if (baselineRow !== undefined) {
    database.prepare(`
      INSERT INTO schema_migrations (
        version, name, checksum, application_version, applied_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      baseline.version,
      baseline.name,
      baseline.checksum,
      LEGACY_APPLICATION_VERSION,
      String(baselineRow.applied_at),
    );
  }
  return readAppliedRows(database);
}

export function applyPendingMigrations(input) {
  validateAppliedMigrations(input.migrations, input.appliedRows);
  if (input.applicationVersion.length === 0) {
    throw new Error("application version is required when applying migrations");
  }
  const now = input.now ?? (() => new Date().toISOString());
  for (const migration of input.migrations.slice(input.appliedRows.length)) {
    migration.apply();
    input.database.prepare(`
      INSERT INTO schema_migrations (
        version, name, checksum, application_version, applied_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      migration.version,
      migration.name,
      migration.checksum,
      input.applicationVersion,
      now(),
    );
  }
}

export function runMigrationLedger(input) {
  validateMigrationRegistry(input.migrations);
  const baseline = input.migrations[0];
  if (baseline === undefined) throw new Error("migration registry must not be empty");
  const appliedRows = prepareMigrationLedger(input.database, baseline);
  validateAppliedMigrations(input.migrations, appliedRows);
  if (appliedRows.length < input.migrations.length) input.beforeApply?.();
  applyPendingMigrations({ ...input, appliedRows });
}

export function defineNaibajiMigrationChain(database) {
  const v12 = defineMigration({
    version: 12,
    name: SEALED_V12_NAME,
    canonicalBody: [
      "NBJ-ARCH-P2/P2-3A",
      "schema-version=12",
      "initial-schema-sql:",
      INITIAL_SCHEMA,
      "legacy-repairs=auth-columns,sop-publication,daily-plan-feedback,v10-amendments,v11-cancel,v12-mode-change",
      "frozen-sop-digest-backfill=on-first-v12-application",
    ].join("\n"),
    apply: () => {
      applyAuditedSchemaV12Structure(database);
      backfillLegacyFrozenSnapshots(database);
    },
  });
  if (v12.checksum !== SEALED_V12_CHECKSUM) {
    throw new Error(`sealed v12 migration identity drift: ${v12.checksum}`);
  }
  const v13 = defineMigration({
    version: CURRENT_MIGRATION_VERSION,
    name: "registered-schema-v13-repair",
    canonicalBody: [
      "NBJ-ARCH-P2/P2-3B",
      "schema-version=13",
      "forward-repair=audited-v12-structure-only",
      "initial-schema-sql:",
      INITIAL_SCHEMA,
      "repair-steps=amendment-v10-rebuild,amendment-action-v11-rebuild,mode-change-v12-rebuild,auth-columns,sop-publication-columns,daily-plan-feedback-columns,users-email-index",
      "frozen-sop-digest-backfill=never",
      "startup-repair=prohibited-when-pending-zero",
    ].join("\n"),
    apply: () => applyAuditedSchemaV12Structure(database),
  });
  return Object.freeze([v12, v13]);
}

export function runNaibajiMigrations(input) {
  const migrations = defineNaibajiMigrationChain(input.database);
  runMigrationLedger({
    database: input.database,
    migrations,
    applicationVersion: input.applicationVersion ?? AGENT_APPLICATION_VERSION,
    now: input.now,
    beforeApply: () => preflightDuplicateActiveDecisions(input.database),
  });
}
