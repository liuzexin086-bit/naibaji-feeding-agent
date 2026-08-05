import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSopMarkdown, searchFrozenKnowledge } from "../src/knowledge/sop-knowledge.js";
import type { FrozenSopKnowledge, SopKnowledgeChunk } from "../src/shared/local-store-contract.js";

const source = `# 首夜教奶\n\n镜头：奶爸机特写\n首日固定在17:00、20:00、23:00、02:00、05:00、08:00下奶。每头每次按标准执行，控奶只关闭指定时段。\n\n# 异常处置\n\n发现腹泻或拒食时立即阻断常规流程，由操作员复核。`;
const canonicalSopPath = "E:\\obsidian_hermes\\hermes\\山川奶爸®超早期断奶SOP完整视频脚本.md";

describe("SOP knowledge parsing and retrieval", () => {
  it("creates immutable section-aware ids and strips filming directions", () => {
    const parsed = parseSopMarkdown(source);
    expect(parsed.chunks.length).toBe(2);
    expect(parsed.chunks[0]?.chunkId).toBe(`${parsed.sourceSha256}:首夜教奶:0`);
    expect(parsed.chunks[0]?.text).not.toContain("镜头");
  });

  it("excludes subtitle, sync-sound, and the complete nested filming appendix", () => {
    const parsed = parseSopMarkdown(`# 操作规则\n\n17:00开始教奶。\n\n## 屏幕重点字幕\n\n这段字幕不能进入知识库。\n\n## 现场同期声\n\n这段同期声不能进入知识库。\n\n# 场内人员需要拍摄的视频\n\n## 1. 观察抢奶情况\n\n腹泻时拍摄特写，这一整段都不是操作证据。\n\n### 配音\n\n附录里的配音同样不能进入知识库。`);
    const corpus = parsed.chunks.map((chunk) => `${chunk.title}\n${chunk.text}`).join("\n");
    expect(corpus).toContain("17:00开始教奶");
    expect(corpus).not.toMatch(/字幕不能|同期声不能|腹泻时拍摄|附录里的配音/u);
  });

  it.skipIf(!existsSync(canonicalSopPath))("parses the canonical SOP without its video appendix", () => {
    const markdown = readFileSync(canonicalSopPath, "utf8");
    const parsed = parseSopMarkdown(markdown);
    const corpus = parsed.chunks.map((chunk) => `${chunk.title}\n${chunk.text}`).join("\n");
    expect(parsed.sourceSha256).toBe("0FBB8F08C22FD9AB4A9A8F15B3A6A7794D7C71D83F3ED8BA9F0436A3AAE1865F");
    expect(corpus).toContain("17点正式开始教奶");
    expect(corpus).not.toContain("场内人员需要拍摄的视频");
    expect(corpus).not.toContain("全部使用横屏拍摄");
    expect(corpus).not.toMatch(/屏幕重点字幕|现场同期声/u);
  });

  it("retrieves an unsegmented Chinese query from the digest-matched lexical fallback", async () => {
    const parsed = parseSopMarkdown(source);
    const frozen: FrozenSopKnowledge = { templateId: "sop-1", sopVersion: "v1",
      sourceSha256: parsed.sourceSha256, collectionRevision: "rev-1", parserVersion: "p1", embeddingModel: "m1" };
    const chunks: SopKnowledgeChunk[] = parsed.chunks.map((chunk) => ({ ...chunk, templateId: "sop-1", collectionRevision: "rev-1" }));
    const result = await searchFrozenKnowledge({ query: "首日几点开始下奶出现腹泻怎么办", frozen, chunks });
    expect(result.source).toBe("lexical_fallback");
    expect(result.results.map((row) => row.title)).toContain("首夜教奶");
    expect(result.results.map((row) => row.title)).toContain("异常处置");
  });

  it("never falls forward to a mismatched latest digest", async () => {
    const parsed = parseSopMarkdown(source);
    const frozen: FrozenSopKnowledge = { templateId: "sop-old", sopVersion: "old",
      sourceSha256: "OLD", collectionRevision: "old-rev", parserVersion: "p1", embeddingModel: "m1" };
    const chunks: SopKnowledgeChunk[] = parsed.chunks.map((chunk) => ({ ...chunk, templateId: "sop-new", collectionRevision: "new-rev" }));
    const result = await searchFrozenKnowledge({ query: "腹泻", frozen, chunks });
    expect(result).toMatchObject({ status: "unavailable", source: "none", results: [] });
  });
});
