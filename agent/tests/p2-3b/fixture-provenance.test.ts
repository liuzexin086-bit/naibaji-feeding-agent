import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStore } from "../../src/local-db/index.js";

interface FixtureManifest {
  fixture: string;
  sha256: string;
  byteSize: number;
  sqliteLibraryVersionObservedAtSanitization: string;
  rawSourceSha256: string;
  rawWalSha256: string;
  sourceApplication: string;
  sourceOrigin: {
    kind: string;
    relativePath: string;
    capturedPurpose: string;
    capturedDate: string;
  };
  observedSourceState: string;
  expectedStartVersion: number;
  expectedOutcome: {
    migrationVersions: number[];
    legacyArchiveVersions: number[];
    integrityCheck: string;
    foreignKeyViolations: number;
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
    frozenEvidence: {
      snapshotSha256: string;
      devicePlanSnapshotSha256: string;
      freeFeedingSlots: Array<Record<string, unknown>>;
      dailyOperationPlan: Record<string, unknown>;
    };
  };
  tableInventory: string[];
  indexInventory: string[];
  sanitizationRecord: {
    secretsPresent: boolean;
    personalDataPresent: boolean;
    liveEndpointsPresent: boolean;
    deviceControlAuthorityPresent: boolean;
  };
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

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").toUpperCase();
}

function digest(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

function names(database: DatabaseSync, type: "table" | "index"): string[] {
  return database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = ? AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all(type).map((row) => String(row.name));
}

function rows(database: DatabaseSync, table: string): Array<Record<string, unknown>> {
  return database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
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

export function postMigrationEvidence(filename: string): {
  ledger: Array<Record<string, unknown>>;
  schemaDigest: string;
  tables: string[];
  indexes: string[];
  businessTables: string[];
  businessDigest: string;
  rawHashes: FixtureManifest["expectedPostMigration"]["rawHashes"];
  frozenEvidence: FixtureManifest["expectedPostMigration"]["frozenEvidence"];
} {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const ledger = database.prepare(`
      SELECT version, name, checksum, application_version, applied_at
      FROM schema_migrations ORDER BY version
    `).all() as Array<Record<string, unknown>>;
    const schemaRows = database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `).all();
    const tables = names(database, "table");
    const indexes = names(database, "index");
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
      .map((table) => ({ table, rows: rows(database, table) }))
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
    const batch = JSON.parse(batchDataJson) as {
      config?: {
        sopTemplate?: Record<string, unknown>;
        devicePlanSnapshot?: Record<string, unknown>;
      };
    };
    const sopTemplate = batch.config?.sopTemplate ?? {};
    const devicePlanSnapshot = batch.config?.devicePlanSnapshot ?? {};
    const plan = database.prepare(
      "SELECT * FROM daily_operation_plans WHERE id = 'fixture-plan'",
    ).get() as Record<string, unknown>;
    return {
      ledger,
      schemaDigest: digest(schemaRows),
      tables,
      indexes,
      businessTables: business.map((entry) => entry.table),
      businessDigest: digest(business),
      rawHashes: {
        batchDataJsonSha256: sha256Text(batchDataJson),
        observationDataJsonSha256: sha256Text(observationDataJson),
        messageContentSha256: sha256Text(messageContent),
      },
      frozenEvidence: {
        snapshotSha256: String(sopTemplate.snapshotSha256 ?? ""),
        devicePlanSnapshotSha256: String(devicePlanSnapshot.sha256 ?? ""),
        freeFeedingSlots: ((devicePlanSnapshot.templates as Record<string, unknown> | undefined)
          ?.free_feeding as { slots?: Array<Record<string, unknown>> } | undefined)?.slots ?? [],
        dailyOperationPlan: plan,
      },
    };
  } finally {
    database.close();
  }
}

export function copyFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-p2-3b-fixture-"));
  cleanupDirectories.push(directory);
  const copyPath = join(directory, "legacy-copy.sqlite");
  copyFileSync(fixturePath, copyPath);
  return copyPath;
}

describe("P2-3B sanitized legacy SQLite fixture", () => {
  it("binds immutable bytes, provenance, inventory, and sanitization assertions", () => {
    expect(sha256File(fixturePath)).toBe(manifest.sha256);
    expect(statSync(fixturePath).size).toBe(manifest.byteSize);
    expect(manifest.rawSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.rawWalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.sourceApplication).toBe("naibaji-feeding-agent legacy local SQLite runtime");
    expect(manifest.sourceOrigin).toMatchObject({
      kind: "real local pre-change backup",
      capturedPurpose: "production-before-agent-context-render",
      capturedDate: "2026-08-04",
    });
    expect(manifest.sourceOrigin.relativePath).toMatch(/naibaji\.db$/);
    expect(manifest.observedSourceState).toContain("two-column schema_migrations through version 5");
    expect(manifest.sanitizationRecord).toMatchObject({
      secretsPresent: false,
      personalDataPresent: false,
      liveEndpointsPresent: false,
      deviceControlAuthorityPresent: false,
    });

    const database = new DatabaseSync(fixturePath, { readOnly: true });
    try {
      expect(manifest.sqliteLibraryVersionObservedAtSanitization).toMatch(/^\d+\.\d+\.\d+$/);
      expect(names(database, "table")).toEqual(manifest.tableInventory);
      expect(names(database, "index")).toEqual(manifest.indexInventory);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version)
        .toBe(manifest.expectedStartVersion);
      expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check)
        .toBe(manifest.expectedOutcome.integrityCheck);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toHaveLength(
        manifest.expectedOutcome.foreignKeyViolations,
      );
      expect(database.prepare("SELECT email, password_hash, password_salt FROM users").all())
        .toEqual([{ email: "fixture-user@example.invalid", password_hash: null, password_salt: null }]);
      expect(database.prepare("SELECT content FROM agent_messages").all())
        .toEqual([{ content: "sanitized fixture message" }]);
    } finally {
      database.close();
    }
  });

  it("migrates a copied fixture with complete manifest-bound business evidence", () => {
    const copyPath = copyFixture();
    const fixtureHashBefore = sha256File(fixturePath);
    const store = createLocalStore({ filename: copyPath });
    store.migrate();
    store.close();

    expect(sha256File(fixturePath)).toBe(fixtureHashBefore);
    const evidence = postMigrationEvidence(copyPath);
    const expected = manifest.expectedPostMigration;
    expectPostMigrationLedger(evidence.ledger, expected.ledger);
    expect(evidence.ledger.map((row) => Number(row.version)))
      .toEqual(manifest.expectedOutcome.migrationVersions);
    expect(evidence.schemaDigest).toBe(expected.schemaDigest);
    expect(evidence.tables).toEqual(expected.tableInventory);
    expect(evidence.indexes).toEqual(expected.indexInventory);
    expect(evidence.businessTables).toEqual(expected.businessTables);
    expect(evidence.businessDigest).toBe(expected.businessDigest);
    expect(evidence.rawHashes).toEqual(expected.rawHashes);
    expect(evidence.frozenEvidence.snapshotSha256).toBe(expected.frozenEvidence.snapshotSha256);
    expect(evidence.frozenEvidence.devicePlanSnapshotSha256)
      .toBe(expected.frozenEvidence.devicePlanSnapshotSha256);
    expect(evidence.frozenEvidence.freeFeedingSlots)
      .toEqual(expected.frozenEvidence.freeFeedingSlots);
    expect(evidence.frozenEvidence.freeFeedingSlots).toHaveLength(8);
    expect(evidence.frozenEvidence.dailyOperationPlan)
      .toEqual(expected.frozenEvidence.dailyOperationPlan);

    const database = new DatabaseSync(copyPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT version, applied_at FROM schema_migrations_legacy ORDER BY version").all())
        .toEqual(manifest.expectedOutcome.legacyArchiveVersions.map((version) => ({
          version,
          applied_at: expect.any(String),
        })));
      expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check)
        .toBe(manifest.expectedOutcome.integrityCheck);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toHaveLength(
        manifest.expectedOutcome.foreignKeyViolations,
      );
      expect(database.prepare(`
        SELECT o.id AS observation_id, b.id AS batch_id, u.id AS user_id
        FROM daily_observations o
        JOIN batches b ON b.user_id = o.user_id AND b.id = o.batch_id
        JOIN users u ON u.id = b.user_id
        WHERE o.id = 'fixture-observation'
      `).all()).toEqual([{
        observation_id: "fixture-observation",
        batch_id: "fixture-batch",
        user_id: "fixture-user",
      }]);
      expect(database.prepare(`
        SELECT c.id AS confirmation_id, p.id AS plan_id, b.id AS batch_id
        FROM daily_operation_confirmations c
        JOIN daily_operation_plans p ON p.id = c.plan_id
        JOIN batches b ON b.user_id = c.user_id AND b.id = c.batch_id
        WHERE c.id = 'fixture-confirmation'
      `).all()).toEqual([{
        confirmation_id: "fixture-confirmation",
        plan_id: "fixture-plan",
        batch_id: "fixture-batch",
      }]);
    } finally {
      database.close();
    }
  });
});
