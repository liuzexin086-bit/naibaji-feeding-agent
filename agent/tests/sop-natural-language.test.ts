import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLocalAdmin } from "../src/container/local-auth.js";
import { MemoryKnowledgeIndex, publishSop } from "../src/knowledge/sop-publication.js";
import { createLocalStore, type SqliteLocalStore } from "../src/local-db/index.js";
import {
  confirmSopEdit,
  draftSopEdit,
  SOP_NL_CONFIRM_PHRASE,
  type SopEditModel,
} from "../src/sop/natural-language.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeStore(): { store: SqliteLocalStore; adminId: string } {
  const directory = mkdtempSync(join(tmpdir(), "naibaji-sop-nl-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = createLocalStore({ filename: join(directory, "local.sqlite") }) as SqliteLocalStore;
  store.migrate();
  cleanups.push(() => store.close());
  const admin = initializeLocalAdmin(store, "admin@example.com", "correct-horse-battery");
  if (!admin) throw new Error("admin bootstrap failed");
  return { store, adminId: admin.id };
}

function fakeModel(payload: unknown): SopEditModel {
  return {
    invoke: async () => new AIMessage(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ),
  };
}

const BASE_MARKDOWN = "# 教奶\n\n17:00 开始教奶，每餐 35g/20头。\n\n# 巡栏\n\n每日巡栏。";

function proposal(markdown: string, config: Record<string, unknown> = {}) {
  return {
    proposedMarkdown: markdown,
    config,
    changeSummary: "按指令调整教奶时间",
    affectedSections: ["教奶"],
  };
}

async function seedTemplate(store: SqliteLocalStore, adminId: string, markdown = BASE_MARKDOWN) {
  return publishSop({
    store,
    index: new MemoryKnowledgeIndex(),
    version: "v1",
    name: "SOP 1",
    config: {},
    sourceMarkdown: markdown,
    createdBy: adminId,
  });
}

class FailingKnowledgeIndex extends MemoryKnowledgeIndex {
  override async verify(): Promise<boolean> {
    return false;
  }
}

describe("SOP natural-language editing", () => {
  it("drafts a modified proposal without changing the active template", async () => {
    const { store, adminId } = makeStore();
    const template = await seedTemplate(store, adminId);
    const task = store.createSopEditTask({
      templateId: template.id,
      instruction: "把教奶时间改为 18:00",
      createdBy: adminId,
    });
    const changed = BASE_MARKDOWN.replace("17:00", "18:00");
    const drafted = await draftSopEdit({
      store,
      model: fakeModel(proposal(changed, { teachingFirstLocal: "18:00" })),
      taskId: task.id,
    });
    expect(drafted.status).toBe("draft_ready");
    expect(drafted.proposedMarkdown).toContain("18:00");
    expect(drafted.proposedConfig?.teachingFirstLocal).toBe("18:00");
    expect(store.getPublishedSopTemplate()?.id).toBe(template.id);
  });

  it("marks unparseable model output as draft_failed", async () => {
    const { store, adminId } = makeStore();
    const task = store.createSopEditTask({
      templateId: null,
      instruction: "新建 SOP",
      createdBy: adminId,
    });
    const drafted = await draftSopEdit({
      store,
      model: fakeModel("这不是 JSON"),
      taskId: task.id,
    });
    expect(drafted.status).toBe("draft_failed");
    expect(drafted.errorCode).toBe("NBJ_SOP_NL_DRAFT_PARSE_FAILED");
  });

  it("marks an unchanged proposal as draft_failed", async () => {
    const { store, adminId } = makeStore();
    const template = await seedTemplate(store, adminId);
    const task = store.createSopEditTask({
      templateId: template.id,
      instruction: "不要改任何内容",
      createdBy: adminId,
    });
    const drafted = await draftSopEdit({
      store,
      model: fakeModel(proposal(BASE_MARKDOWN)),
      taskId: task.id,
    });
    expect(drafted.status).toBe("draft_failed");
    expect(drafted.errorCode).toBe("NBJ_SOP_NL_DRAFT_UNCHANGED");
  });

  it("requires the confirmation phrase and then publishes atomically", async () => {
    const { store, adminId } = makeStore();
    const template = await seedTemplate(store, adminId);
    const task = store.createSopEditTask({
      templateId: template.id,
      instruction: "把教奶时间改为 18:00",
      createdBy: adminId,
    });
    const changed = BASE_MARKDOWN.replace("17:00", "18:00");
    await draftSopEdit({
      store,
      model: fakeModel(proposal(changed)),
      taskId: task.id,
    });
    await expect(confirmSopEdit({
      store,
      index: new MemoryKnowledgeIndex(),
      taskId: task.id,
      version: "v2",
      name: "SOP 2",
      confirmationPhrase: "错误短语",
      confirmedBy: adminId,
    })).rejects.toThrow("NBJ_SOP_NL_CONFIRM_PHRASE_MISMATCH");
    const result = await confirmSopEdit({
      store,
      index: new MemoryKnowledgeIndex(),
      taskId: task.id,
      version: "v2",
      name: "SOP 2",
      confirmationPhrase: SOP_NL_CONFIRM_PHRASE,
      confirmedBy: adminId,
    });
    expect(result.task.status).toBe("published");
    expect(result.task.publishedTemplateId).toBe(result.template.id);
    expect(store.getPublishedSopTemplate()?.id).toBe(result.template.id);
  });

  it("keeps the task draft_ready when index verification fails", async () => {
    const { store, adminId } = makeStore();
    const template = await seedTemplate(store, adminId);
    const task = store.createSopEditTask({
      templateId: template.id,
      instruction: "把教奶时间改为 18:00",
      createdBy: adminId,
    });
    const changed = BASE_MARKDOWN.replace("17:00", "18:00");
    await draftSopEdit({
      store,
      model: fakeModel(proposal(changed)),
      taskId: task.id,
    });
    await expect(confirmSopEdit({
      store,
      index: new FailingKnowledgeIndex(),
      taskId: task.id,
      version: "v2",
      name: "SOP 2",
      confirmationPhrase: SOP_NL_CONFIRM_PHRASE,
      confirmedBy: adminId,
    })).rejects.toThrow("NBJ_SOP_INDEX_VERIFY_FAILED");
    expect(store.getSopEditTask(task.id)?.status).toBe("draft_ready");
    expect(store.getPublishedSopTemplate()?.id).toBe(template.id);
  });

  it("drafts and publishes a brand-new template", async () => {
    const { store, adminId } = makeStore();
    const task = store.createSopEditTask({
      templateId: null,
      instruction: "新建一份简单 SOP",
      createdBy: adminId,
    });
    const markdown = "# 新 SOP\n\n每日 09:00 巡栏。";
    await draftSopEdit({
      store,
      model: fakeModel(proposal(markdown, { teachingFirstLocal: "17:00" })),
      taskId: task.id,
    });
    const result = await confirmSopEdit({
      store,
      index: new MemoryKnowledgeIndex(),
      taskId: task.id,
      version: "v1",
      name: "新模板",
      confirmationPhrase: SOP_NL_CONFIRM_PHRASE,
      confirmedBy: adminId,
    });
    expect(result.task.status).toBe("published");
    expect(result.template.sourceTemplateId).toBeNull();
    expect(store.getPublishedSopTemplate()?.id).toBe(result.template.id);
  });

  it("guards terminal task transitions in the store", async () => {
    const { store, adminId } = makeStore();
    const task = store.createSopEditTask({
      templateId: null,
      instruction: "只测试状态守卫",
      createdBy: adminId,
    });
    expect(() => store.publishSopEditTask({
      taskId: task.id,
      publishedTemplateId: "missing",
      confirmedBy: adminId,
    })).toThrow();
    expect(() => store.failSopEditTaskDraft({
      taskId: task.id,
      errorCode: "NBJ_SOP_NL_DRAFT_FAILED",
    })).not.toThrow();
    expect(store.getSopEditTask(task.id)?.status).toBe("draft_failed");
    expect(() => store.rejectSopEditTask({
      taskId: task.id,
      rejectedBy: adminId,
    })).not.toThrow();
    expect(store.getSopEditTask(task.id)?.status).toBe("rejected");
  });

  it("uses pasted SOP markdown directly for a new template without calling the model", async () => {
    const { store, adminId } = makeStore();
    const pasted = "# 教奶\n\n17:00 开始教奶。\n\n# 巡栏\n\n每日巡栏。";
    const task = store.createSopEditTask({
      templateId: null,
      instruction: pasted,
      createdBy: adminId,
    });
    let modelCalls = 0;
    const drafted = await draftSopEdit({
      store,
      model: {
        invoke: async () => {
          modelCalls += 1;
          throw new Error("model must not be called");
        },
      },
      taskId: task.id,
    });
    expect(drafted.status).toBe("draft_ready");
    expect(drafted.proposedMarkdown).toBe(pasted);
    expect(drafted.affectedSections).toContain("教奶");
    expect(modelCalls).toBe(0);
  });

  it("fails a long non-markdown instruction before invoking the model", async () => {
    const { store, adminId } = makeStore();
    const longInstruction = "<!-- 注释 -->\n".repeat(400);
    const task = store.createSopEditTask({
      templateId: null,
      instruction: longInstruction,
      createdBy: adminId,
    });
    const drafted = await draftSopEdit({
      store,
      model: fakeModel(proposal("# 新 SOP\n\n每日巡栏。")),
      taskId: task.id,
    });
    expect(drafted.status).toBe("draft_failed");
    expect(drafted.errorCode).toBe("NBJ_SOP_NL_INSTRUCTION_TOO_LONG");
  });

  it("treats a long plain-text SOP paste as a direct new template", async () => {
    const { store, adminId } = makeStore();
    const pasted = "超早期断奶 SOP\n\n▎ 适用对象：体重约 2.3–4.4 kg 的仔猪\n▎ 核心设备：奶爸机\n\n每日巡栏。\n".repeat(100);
    expect(pasted.length).toBeGreaterThan(4_000);
    const task = store.createSopEditTask({
      templateId: null,
      instruction: pasted,
      createdBy: adminId,
    });
    let modelCalls = 0;
    const drafted = await draftSopEdit({
      store,
      model: {
        invoke: async () => {
          modelCalls += 1;
          throw new Error("model must not be called");
        },
      },
      taskId: task.id,
    });
    expect(drafted.status).toBe("draft_ready");
    expect(drafted.proposedMarkdown).toBe(pasted);
    expect(modelCalls).toBe(0);
  });
});
