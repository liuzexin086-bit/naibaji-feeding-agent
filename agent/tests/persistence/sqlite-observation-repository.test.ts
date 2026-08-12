import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStore } from "../../src/local-db/index.js";
import { parseObservation } from "../../src/domain/observation.js";
import { SqliteObservationRepository } from "../../src/persistence/sqlite-observation-repository.js";
import type { ObservationRepositoryEntry, PersistedObservation } from "../../src/persistence/contracts.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fileName(): string {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-observation-persistence-"));
  directories.push(directory);
  return join(directory, "agent.sqlite");
}

function persisted(entries: ObservationRepositoryEntry[]): PersistedObservation[] {
  return entries.filter((entry): entry is PersistedObservation => !("kind" in entry));
}

describe("SQLite observation repository", () => {
  it("round-trips omitted, explicit none, mild, null, and zero across close/reopen", () => {
    const filename = fileName();
    const firstStore = createLocalStore({ filename });
    firstStore.migrate();
    firstStore.createBatch({ userId: "user-a", batchId: "batch-1", revision: 0 });
    const firstRepository = new SqliteObservationRepository(firstStore);
    const observations = [
      parseObservation({ actualPowderGrams: null }),
      parseObservation({ diarrheaGrade: "none", actualPowderGrams: null }),
      parseObservation({ diarrheaGrade: "mild", actualPowderGrams: 0 }),
    ];
    observations.forEach((observation, index) => {
      firstRepository.append({
        userId: "user-a",
        batchId: "batch-1",
        dateLocal: "2026-08-12",
        batchRevision: 0,
        observation,
        idempotencyKey: `observation-${index}`,
      });
    });
    firstStore.close();

    const reopenedStore = createLocalStore({ filename });
    reopenedStore.migrate();
    try {
      const entries = new SqliteObservationRepository(reopenedStore).list("user-a", "batch-1");
      const rows = persisted(entries);
      const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]));
      expect(entries).toHaveLength(3);
      expect(byKey.get("observation-0")?.observation.diarrheaGrade).toEqual({ kind: "not_observed" });
      expect(byKey.get("observation-1")?.observation.diarrheaGrade).toEqual({ kind: "observed", value: "none" });
      expect(byKey.get("observation-2")?.observation.diarrheaGrade).toEqual({ kind: "observed", value: "mild" });
      expect(byKey.get("observation-0")?.observation.actualPowderGrams).toBeNull();
      expect(byKey.get("observation-2")?.observation.actualPowderGrams).toBe(0);
    } finally {
      reopenedStore.close();
    }
  });

  it("quarantines an invalid legacy row instead of collapsing or dropping it", () => {
    const filename = fileName();
    const store = createLocalStore({ filename });
    store.migrate();
    store.createBatch({ userId: "user-a", batchId: "batch-1", revision: 0 });
    store.close();
    const database = new DatabaseSync(filename);
    database.prepare(`
      INSERT INTO daily_observations (
        user_id, id, batch_id, date_local, observed_at, batch_revision,
        data_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "user-a",
      "invalid-observation",
      "batch-1",
      "2026-08-12",
      "2026-08-12T01:00:00.000Z",
      0,
      JSON.stringify({ diarrheaGrade: "invented", actualPowderGrams: 0 }),
      "invalid-observation-key",
      "2026-08-12T01:00:00.000Z",
    );
    database.close();
    const reopened = createLocalStore({ filename });
    reopened.migrate();
    const entries = new SqliteObservationRepository(reopened).list("user-a", "batch-1");
    expect(entries).toEqual([expect.objectContaining({
      kind: "quarantine",
      id: "invalid-observation",
      reason: "PERSISTENCE_OBSERVATION_INVALID",
    })]);
    reopened.close();
  });
});
