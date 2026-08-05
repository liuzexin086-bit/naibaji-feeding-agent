import type { FrozenSopKnowledge, SopKnowledgeChunk } from "../shared/local-store-contract.js";
import { SOP_COLLECTION_NAME, type KnowledgeSearchResult, type SopKnowledgeIndex } from "./sop-knowledge.js";

export interface ChromaIndexOptions {
  chromaUrl: string;
  embeddingBaseUrl: string;
  collectionName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ChromaKnowledgeIndex implements SopKnowledgeIndex {
  readonly #fetch: typeof fetch;
  readonly #chromaUrl: string;
  readonly #embeddingBaseUrl: string;
  readonly #collectionName: string;
  readonly #timeoutMs: number;

  constructor(options: ChromaIndexOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#chromaUrl = options.chromaUrl.replace(/\/$/, "");
    this.#embeddingBaseUrl = options.embeddingBaseUrl.replace(/\/$/, "");
    this.#collectionName = options.collectionName ?? SOP_COLLECTION_NAME;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async #json(url: string, init: RequestInit): Promise<any> {
    const response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs),
      headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    if (!response.ok) throw new Error(`NBJ_KNOWLEDGE_SERVICE_${response.status}`);
    return response.json();
  }

  async #embeddings(input: string[], model: string): Promise<number[][]> {
    const body = await this.#json(`${this.#embeddingBaseUrl}/v1/embeddings`, {
      method: "POST", body: JSON.stringify({ input, model }),
    }) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = body.data ?? [];
    if (rows.length !== input.length) throw new Error("NBJ_EMBEDDING_COUNT_MISMATCH");
    return [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((row) => {
      if (!Array.isArray(row.embedding)) throw new Error("NBJ_EMBEDDING_INVALID");
      return row.embedding;
    });
  }

  async #collection(): Promise<{ id: string }> {
    const base = `${this.#chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`;
    const collection = await this.#json(base, { method: "POST", body: JSON.stringify({ name: this.#collectionName, get_or_create: true }) });
    if (!collection?.id) throw new Error("NBJ_CHROMA_COLLECTION_INVALID");
    return collection;
  }

  async upsert(chunks: SopKnowledgeChunk[], embeddingModel: string): Promise<void> {
    const collection = await this.#collection();
    for (let offset = 0; offset < chunks.length; offset += 64) {
      const batch = chunks.slice(offset, offset + 64);
      const embeddings = await this.#embeddings(batch.map((row) => `${row.title}\n${row.text}`), embeddingModel);
      await this.#json(`${this.#chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${collection.id}/upsert`, {
        method: "POST", body: JSON.stringify({
          ids: batch.map((row) => row.chunkId), embeddings, documents: batch.map((row) => row.text),
          metadatas: batch.map((row) => ({ templateId: row.templateId, sectionId: row.sectionId,
            title: row.title, sourceSha256: row.sourceSha256, collectionRevision: row.collectionRevision })),
        }),
      });
    }
  }

  async verify(frozen: FrozenSopKnowledge, expectedChunkIds: string[]): Promise<boolean> {
    const collection = await this.#collection();
    const response = await this.#json(`${this.#chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${collection.id}/get`, {
      method: "POST", body: JSON.stringify({ ids: expectedChunkIds, include: ["metadatas"] }),
    }) as { ids?: string[]; metadatas?: Array<Record<string, unknown>> };
    return response.ids?.length === expectedChunkIds.length && response.metadatas?.every((metadata) =>
      metadata.sourceSha256 === frozen.sourceSha256 && metadata.collectionRevision === frozen.collectionRevision) === true;
  }

  async query(query: string, frozen: FrozenSopKnowledge, limit: number): Promise<KnowledgeSearchResult[]> {
    const collection = await this.#collection();
    const [embedding] = await this.#embeddings([query], frozen.embeddingModel);
    const response = await this.#json(`${this.#chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${collection.id}/query`, {
      method: "POST", body: JSON.stringify({ query_embeddings: [embedding], n_results: limit,
        where: { "$and": [{ sourceSha256: frozen.sourceSha256 }, { collectionRevision: frozen.collectionRevision }] },
        include: ["documents", "metadatas", "distances"] }),
    }) as { ids?: string[][]; documents?: string[][]; metadatas?: Array<Array<Record<string, unknown>>>; distances?: number[][] };
    return (response.ids?.[0] ?? []).map((chunkId, index) => ({ chunkId,
      sectionId: String(response.metadatas?.[0]?.[index]?.sectionId ?? ""),
      title: String(response.metadatas?.[0]?.[index]?.title ?? ""), text: String(response.documents?.[0]?.[index] ?? ""),
      score: 1 / (1 + Number(response.distances?.[0]?.[index] ?? 1)), }));
  }
}
