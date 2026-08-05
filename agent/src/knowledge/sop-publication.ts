import { randomUUID } from "node:crypto";
import type { LocalSopTemplate, LocalStore, SopKnowledgeChunk } from "../shared/local-store-contract.js";
import { defaultFreeFeedingSlots, normalizeFreeFeedingSlots } from "../decision/free-feeding-slots.js";
import { DEFAULT_EMBEDDING_MODEL, SOP_PARSER_VERSION, parseSopMarkdown, type SopKnowledgeIndex } from "./sop-knowledge.js";

function indexedChunkId(input: {
  sourceSha256: string;
  templateId: string;
  collectionRevision: string;
  sectionId: string;
  chunkIndex: number;
}): string {
  return [input.sourceSha256, input.templateId, input.collectionRevision, input.sectionId, input.chunkIndex].join(":");
}

function normalizedPublicationConfig(config: Record<string, unknown>): Record<string, unknown> {
  const free = config.freeFeedingTemplate;
  if (free !== undefined && (!free || typeof free !== "object" || Array.isArray(free))) {
    throw new Error("NBJ_FREE_FEEDING_SLOTS_INVALID");
  }
  const template = free as Record<string, unknown> | undefined;
  const slots = normalizeFreeFeedingSlots(template?.windows ?? defaultFreeFeedingSlots());
  return {
    ...structuredClone(config),
    freeFeedingTemplate: {
      ...(template ? structuredClone(template) : {}),
      windows: slots,
    },
  };
}

export async function publishSop(input: {
  store: LocalStore;
  index: SopKnowledgeIndex;
  version: string;
  name: string;
  config: Record<string, unknown>;
  sourceMarkdown: string;
  createdBy: string;
  sourceTemplateId?: string | null;
  embeddingModel?: string;
}): Promise<LocalSopTemplate> {
  const config = normalizedPublicationConfig(input.config);
  const parsed = parseSopMarkdown(input.sourceMarkdown);
  const collectionRevision = randomUUID();
  const embeddingModel = input.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const draft = input.store.createSopTemplate({ version: input.version, name: input.name, config,
    createdBy: input.createdBy, sourceTemplateId: input.sourceTemplateId, sourceMarkdown: input.sourceMarkdown,
    sourceSha256: parsed.sourceSha256, collectionRevision, parserVersion: SOP_PARSER_VERSION, embeddingModel });
  const chunks: SopKnowledgeChunk[] = parsed.chunks.map((chunk) => ({ ...chunk,
    chunkId: indexedChunkId({ ...chunk, templateId: draft.id, collectionRevision }),
    templateId: draft.id, collectionRevision }));
  const frozen = { templateId: draft.id, sopVersion: draft.version, sourceSha256: parsed.sourceSha256,
    collectionRevision, parserVersion: SOP_PARSER_VERSION, embeddingModel };
  try {
    await input.index.upsert(chunks, embeddingModel);
    if (!await input.index.verify(frozen, chunks.map((chunk) => chunk.chunkId))) {
      throw new Error("NBJ_SOP_INDEX_VERIFY_FAILED");
    }
    return input.store.publishSopTemplate({ templateId: draft.id, chunks });
  } catch (error) {
    input.store.failSopTemplate(draft.id, error instanceof Error ? error.message : "NBJ_SOP_INDEX_FAILED");
    throw error;
  }
}

/** Used for local/offline publication while retaining the same verify-before-activate contract. */
export class MemoryKnowledgeIndex implements SopKnowledgeIndex {
  readonly #chunks = new Map<string, SopKnowledgeChunk>();
  async upsert(chunks: SopKnowledgeChunk[]): Promise<void> { for (const chunk of chunks) this.#chunks.set(chunk.chunkId, chunk); }
  async verify(frozen: { sourceSha256: string; collectionRevision: string }, ids: string[]): Promise<boolean> {
    return ids.every((id) => { const row = this.#chunks.get(id); return row?.sourceSha256 === frozen.sourceSha256 && row.collectionRevision === frozen.collectionRevision; });
  }
  async query(): Promise<never[]> { return []; }
}
