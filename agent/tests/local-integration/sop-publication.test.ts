import { afterEach, describe, expect, it } from "vitest";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";
import { MemoryKnowledgeIndex, publishSop } from "../../src/knowledge/sop-publication.js";
import type { SopKnowledgeIndex } from "../../src/knowledge/sop-knowledge.js";

const stores: SqliteLocalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function setup() {
  const store = createLocalStore({ filename: ":memory:" }) as SqliteLocalStore;
  store.migrate();
  store.createUser({ id: "admin", email: "admin@example.com", passwordHash: "hash", passwordSalt: "salt", role: "admin" });
  stores.push(store);
  return store;
}

describe("atomic SOP publication", () => {
  it("publishes only after index verification and stores lexical chunks", async () => {
    const store = setup();
    const published = await publishSop({ store, index: new MemoryKnowledgeIndex(), version: "v1", name: "SOP",
      config: {}, sourceMarkdown: "# 教奶\n\n17:00开始教奶。", createdBy: "admin" });
    expect(published.status).toBe("published");
    expect(store.getPublishedSopTemplate()?.id).toBe(published.id);
    expect(store.listSopKnowledgeChunks(published.id)).toHaveLength(1);
    const slots = ((published.config.freeFeedingTemplate as Record<string, unknown>).windows as unknown[]);
    expect(slots).toHaveLength(8);
  });

  it("rejects publishing a partial free-feeding slot configuration", async () => {
    const store = setup();
    await expect(publishSop({ store, index: new MemoryKnowledgeIndex(), version: "v-slots", name: "SOP",
      config: { freeFeedingTemplate: { windows: [] } }, sourceMarkdown: "# SOP", createdBy: "admin" }))
      .rejects.toThrow("NBJ_FREE_FEEDING_SLOTS_INVALID");
  });

  it("preserves the previous active version when a new index verification fails", async () => {
    const store = setup();
    const first = await publishSop({ store, index: new MemoryKnowledgeIndex(), version: "v1", name: "SOP 1",
      config: {}, sourceMarkdown: "# 教奶\n\n17:00开始教奶。", createdBy: "admin" });
    const failing: SopKnowledgeIndex = { async upsert() {}, async verify() { return false; }, async query() { return []; } };
    await expect(publishSop({ store, index: failing, version: "v2", name: "SOP 2", config: {},
      sourceMarkdown: "# 控奶\n\n只关闭指定时段。", createdBy: "admin" })).rejects.toThrow("NBJ_SOP_INDEX_VERIFY_FAILED");
    expect(store.getPublishedSopTemplate()?.id).toBe(first.id);
    expect(store.listSopTemplates().find((row) => row.version === "v2")?.status).toBe("failed");
  });

  it("keeps both dense revisions when identical source text is republished", async () => {
    const store = setup();
    const index = new MemoryKnowledgeIndex();
    const sourceMarkdown = "# 教奶\n\n17:00开始教奶，之后每3小时少量给奶一次。";
    const first = await publishSop({ store, index, version: "v1", name: "SOP 1",
      config: {}, sourceMarkdown, createdBy: "admin" });
    const second = await publishSop({ store, index, version: "v2", name: "SOP 2",
      config: {}, sourceMarkdown, createdBy: "admin", sourceTemplateId: first.id });
    const firstChunks = store.listSopKnowledgeChunks(first.id);
    const secondChunks = store.listSopKnowledgeChunks(second.id);
    expect(first.sourceSha256).toBe(second.sourceSha256);
    expect(new Set([...firstChunks, ...secondChunks].map((chunk) => chunk.chunkId)).size)
      .toBe(firstChunks.length + secondChunks.length);
    await expect(index.verify({ templateId: first.id, sopVersion: first.version,
      sourceSha256: first.sourceSha256, collectionRevision: first.collectionRevision,
      parserVersion: first.parserVersion, embeddingModel: first.embeddingModel },
    firstChunks.map((chunk) => chunk.chunkId))).resolves.toBe(true);
    await expect(index.verify({ templateId: second.id, sopVersion: second.version,
      sourceSha256: second.sourceSha256, collectionRevision: second.collectionRevision,
      parserVersion: second.parserVersion, embeddingModel: second.embeddingModel },
    secondChunks.map((chunk) => chunk.chunkId))).resolves.toBe(true);
  });
});
