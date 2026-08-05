import { createHash } from "node:crypto";
import type { FrozenSopKnowledge, SopKnowledgeChunk } from "../shared/local-store-contract.js";

export const SOP_PARSER_VERSION = "sop-section-parser@2";
export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-zh-v1.5";
export const SOP_COLLECTION_NAME = "naibaji_sop";

export interface ParsedSopChunk extends Omit<SopKnowledgeChunk, "templateId" | "collectionRevision"> {}

export interface KnowledgeSearchResult {
  chunkId: string;
  sectionId: string;
  title: string;
  text: string;
  score: number;
}

export interface KnowledgeSearchResponse {
  status: "ok" | "unavailable";
  source: "dense+lexical" | "lexical_fallback" | "none";
  sopVersion: string;
  sourceSha256: string;
  collectionRevision: string;
  embeddingModel: string;
  results: KnowledgeSearchResult[];
  reason?: string;
}

export interface SopKnowledgeIndex {
  upsert(chunks: SopKnowledgeChunk[], embeddingModel: string): Promise<void>;
  verify(frozen: FrozenSopKnowledge, expectedChunkIds: string[]): Promise<boolean>;
  query(query: string, frozen: FrozenSopKnowledge, limit: number): Promise<KnowledgeSearchResult[]>;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text.normalize("NFC"), "utf8").digest("hex").toUpperCase();
}

function slug(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function operationalLines(markdown: string): string[] {
  return markdown.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => {
    const value = line.trim();
    if (!value) return true;
    return !/^(?:[-*]\s*)?(?:镜头|画面|字幕|拍摄提示|运镜|配乐|转场|景别|机位)\s*[：:]/u.test(value) &&
      !/^<!--.*-->$/.test(value);
  });
}

function isFilmingHeading(title: string): boolean {
  const normalized = title.replace(/[*_`]/g, "").trim();
  return /^(?:镜头|画面|拍摄提示|运镜|配乐|转场|景别|机位)/u.test(normalized) ||
    /(?:字幕|同期声)/u.test(normalized) ||
    /^场内人员需要拍摄的视频$/u.test(normalized) ||
    /^拍摄统一要求$/u.test(normalized);
}

function splitText(text: string, minimum: number, maximum: number): string[] {
  if (text.length <= maximum) return text.trim() ? [text.trim()] : [];
  const sentences = text.split(/(?<=[。！？；\n])/u).map((part) => part.trim()).filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maximum && current.length >= minimum) {
      result.push(current);
      current = "";
    }
    if (sentence.length > maximum) {
      if (current) result.push(current);
      current = "";
      for (let offset = 0; offset < sentence.length; offset += maximum) {
        result.push(sentence.slice(offset, offset + maximum));
      }
    } else {
      current += (current ? "\n" : "") + sentence;
    }
  }
  if (current) {
    const previous = result.at(-1);
    if (previous && current.length < minimum && previous.length + current.length + 1 <= maximum) {
      result[result.length - 1] = `${previous}\n${current}`;
    } else result.push(current);
  }
  return result;
}

export function normalizeChineseQuery(value: string): string {
  const aliases: Array<[RegExp, string]> = [
    [/教槽料|开口料/gu, "教槽"], [/拉稀|稀便/gu, "腹泻"], [/断奶仔猪|小猪/gu, "仔猪"],
    [/喂奶|饲喂/gu, "下奶"], [/掉队仔猪|弱仔/gu, "掉队猪"], [/机器|奶妈机/gu, "奶爸机"],
  ];
  let normalized = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  for (const [pattern, replacement] of aliases) normalized = normalized.replace(pattern, replacement);
  return normalized.replace(/[^\p{Letter}\p{Number}.:%：-]+/gu, "");
}

export function lexicalTerms(value: string): string[] {
  const normalized = normalizeChineseQuery(value);
  const terms = new Set<string>();
  if (normalized) terms.add(normalized);
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?(?:%|克|g|天|日龄|次|小时|分钟)?/gu)) {
    terms.add(match[0]);
  }
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= normalized.length; index += 1) {
      terms.add(normalized.slice(index, index + size));
    }
  }
  return [...terms];
}

export function parseSopMarkdown(markdown: string): {
  sourceSha256: string;
  chunks: ParsedSopChunk[];
} {
  const sourceSha256 = sha256Text(markdown);
  const sections: Array<{ title: string; id: string; lines: string[] }> = [];
  const headings: Array<{ level: number; title: string; filming: boolean }> = [];
  let current = { title: "总则", id: "general", lines: [] as string[] };
  let skipFilming = false;
  const flush = () => {
    if (current.lines.some((item) => item.trim())) sections.push(current);
  };
  for (const line of operationalLines(markdown)) {
    const markdownHeading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/u);
    const plainHeading = line.match(/^(第[一二三四五六七八九十百\d]+(?:章|节|部分)[：:\s].+)$/u);
    const heading = markdownHeading ? { level: markdownHeading[1]!.length, title: markdownHeading[2]!.trim() }
      : plainHeading ? { level: 1, title: plainHeading[1]!.trim() } : null;
    if (heading) {
      flush();
      while (headings.length > 0 && headings[headings.length - 1]!.level >= heading.level) headings.pop();
      const parentHeading = headings.at(-1);
      const filming = isFilmingHeading(heading.title) || parentHeading?.filming === true;
      const narration = /^(?:配音|口播)(?:\s|$)/u.test(heading.title);
      const parent = [...headings].reverse().find((row) => !row.filming);
      headings.push({ ...heading, filming });
      skipFilming = filming;
      const title = narration && parent ? parent.title : heading.title;
      current = { title, id: slug(title, `section-${sections.length + 1}`), lines: [] };
      if (narration && !filming) skipFilming = false;
    } else if (!skipFilming) current.lines.push(line);
  }
  flush();

  const seen = new Map<string, number>();
  const chunks: ParsedSopChunk[] = [];
  for (const section of sections) {
    const occurrence = seen.get(section.id) ?? 0;
    seen.set(section.id, occurrence + 1);
    const sectionId = occurrence === 0 ? section.id : `${section.id}-${occurrence + 1}`;
    const text = section.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    for (const [chunkIndex, chunkText] of splitText(text, 300, 800).entries()) {
      chunks.push({
        chunkId: `${sourceSha256}:${sectionId}:${chunkIndex}`,
        sectionId,
        chunkIndex,
        title: section.title,
        text: chunkText,
        sourceSha256,
        lexicalTerms: lexicalTerms(`${section.title}${chunkText}`),
      });
    }
  }
  if (chunks.length === 0) throw new Error("NBJ_SOP_SOURCE_EMPTY");
  return { sourceSha256, chunks };
}

function lexicalRank(query: string, chunks: SopKnowledgeChunk[], limit: number): KnowledgeSearchResult[] {
  const queryNormalized = normalizeChineseQuery(query);
  const queryTerms = lexicalTerms(query);
  return chunks.map((chunk) => {
    const document = normalizeChineseQuery(`${chunk.title}${chunk.text}`);
    let score = queryNormalized && document.includes(queryNormalized) ? 20 : 0;
    const stored = new Set(chunk.lexicalTerms);
    for (const term of queryTerms) {
      if (stored.has(term)) score += Math.min(4, term.length);
      else if (/\d/.test(term) && document.includes(term)) score += 6;
    }
    return { chunkId: chunk.chunkId, sectionId: chunk.sectionId, title: chunk.title, text: chunk.text, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, limit);
}

function combineResults(dense: KnowledgeSearchResult[], lexical: KnowledgeSearchResult[], limit: number): KnowledgeSearchResult[] {
  const combined = new Map<string, KnowledgeSearchResult>();
  const add = (rows: KnowledgeSearchResult[], weight: number) => rows.forEach((row, index) => {
    const score = weight / (60 + index + 1);
    const prior = combined.get(row.chunkId);
    combined.set(row.chunkId, { ...row, score: (prior?.score ?? 0) + score });
  });
  add(dense, 1); add(lexical, 1.25);
  return [...combined.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchFrozenKnowledge(input: {
  query: string;
  frozen: FrozenSopKnowledge | null;
  chunks: SopKnowledgeChunk[];
  index?: SopKnowledgeIndex | null;
  limit?: number;
}): Promise<KnowledgeSearchResponse> {
  const limit = Math.max(1, Math.min(10, input.limit ?? 5));
  const frozen = input.frozen;
  if (!frozen) return {
    status: "unavailable", source: "none", sopVersion: "", sourceSha256: "",
    collectionRevision: "", embeddingModel: "", results: [], reason: "batch_has_no_frozen_sop_digest",
  };
  const chunks = input.chunks.filter((chunk) => chunk.templateId === frozen.templateId &&
    chunk.sourceSha256 === frozen.sourceSha256 && chunk.collectionRevision === frozen.collectionRevision);
  if (chunks.length === 0) return {
    status: "unavailable", source: "none", ...frozen, results: [], reason: "digest_matched_lexical_index_missing",
  };
  const lexical = lexicalRank(input.query, chunks, limit * 2);
  if (input.index) {
    try {
      const dense = await input.index.query(input.query, frozen, limit * 2);
      return { status: "ok", source: "dense+lexical", ...frozen, results: combineResults(dense, lexical, limit) };
    } catch {
      // A digest-matched local index is the only allowed fallback.
    }
  }
  return { status: "ok", source: "lexical_fallback", ...frozen, results: lexical.slice(0, limit) };
}

/** Legacy helper retained for callers without a batch; it deliberately returns unavailable. */
export function searchKnowledge(_query: string): KnowledgeSearchResponse {
  return { status: "unavailable", source: "none", sopVersion: "", sourceSha256: "",
    collectionRevision: "", embeddingModel: "", results: [], reason: "frozen_batch_context_required" };
}
