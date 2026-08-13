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

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function names(database: DatabaseSync, type: "table" | "index"): string[] {
  return database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = ? AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all(type).map((row) => String(row.name));
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
      expect(manifest.sqliteLibraryVersionObservedAtSanitization)
        .toMatch(/^\d+\.\d+\.\d+$/);
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
        .toEqual([{
          email: "fixture-user@example.invalid",
          password_hash: null,
          password_salt: null,
        }]);
      expect(database.prepare("SELECT content FROM agent_messages").all())
        .toEqual([{ content: "sanitized fixture message" }]);
    } finally {
      database.close();
    }
  });

  it("copies the immutable source, migrates only the copy, and preserves relations", () => {
    const directory = mkdtempSync(join(tmpdir(), "naibaji-p2-3b-fixture-"));
    cleanupDirectories.push(directory);
    const copyPath = join(directory, "legacy-copy.sqlite");
    copyFileSync(fixturePath, copyPath);
    const fixtureHashBefore = sha256File(fixturePath);

    const store = createLocalStore({ filename: copyPath });
    store.migrate();
    store.close();

    expect(sha256File(fixturePath)).toBe(fixtureHashBefore);
    const database = new DatabaseSync(copyPath, { readOnly: true });
    try {
      expect(database.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all().map((row) => Number(row.version))).toEqual(
        manifest.expectedOutcome.migrationVersions,
      );
      expect(database.prepare(
        "SELECT version FROM schema_migrations_legacy ORDER BY version",
      ).all().map((row) => Number(row.version))).toEqual(
        manifest.expectedOutcome.legacyArchiveVersions,
      );
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
      `).all()).toEqual([{
        confirmation_id: "fixture-confirmation",
        plan_id: "fixture-plan",
        batch_id: "fixture-batch",
      }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM batches").get()?.count).toBe(1);
      expect(database.prepare("SELECT COUNT(*) AS count FROM daily_observations").get()?.count)
        .toBe(1);
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_messages").get()?.count)
        .toBe(1);
    } finally {
      database.close();
    }
  });
});
