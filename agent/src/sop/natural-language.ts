import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { LocalSopTemplate, LocalStore, SopEditTask } from "../shared/local-store-contract.js";
import {
  defaultFreeFeedingSlots,
  normalizeFreeFeedingSlots,
} from "../decision/free-feeding-slots.js";
import {
  parseSopMarkdown,
  sha256Text,
} from "../knowledge/sop-knowledge.js";
import {
  publishSop,
} from "../knowledge/sop-publication.js";
import type { SopKnowledgeIndex } from "../knowledge/sop-knowledge.js";

export const SOP_NL_CONFIRM_PHRASE = "发布 SOP 修改";
export const SOP_NL_INSTRUCTION_MAX = 200_000;
export const SOP_NL_LLM_INSTRUCTION_MAX = 4_000;
export const SOP_NL_MARKDOWN_MAX = 200_000;

export interface SopEditModel {
  invoke(input: BaseMessage[], options?: Record<string, unknown>): Promise<BaseMessage>;
}

export interface SopEditProposal {
  proposedMarkdown: string;
  config: Record<string, unknown>;
  changeSummary: string;
  affectedSections: string[];
}

function messageText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => {
    if (typeof block === "string") return [block];
    return block && typeof block === "object" && "text" in block ? [String(block.text ?? "")] : [];
  }).join("");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function draftErrorCode(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("NBJ_")) return error.message;
  return "NBJ_SOP_NL_DRAFT_FAILED";
}

function parseProposalJson(content: string): SopEditProposal {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/u);
  const raw = fenced ? fenced[1].trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NBJ_SOP_NL_DRAFT_PARSE_FAILED");
  }
  const root = objectValue(parsed);
  if (!root) throw new Error("NBJ_SOP_NL_DRAFT_PARSE_FAILED");
  const proposedMarkdown = root.proposedMarkdown;
  const changeSummary = root.changeSummary;
  const affectedSections = root.affectedSections;
  const config = objectValue(root.config);
  if (typeof proposedMarkdown !== "string" || !proposedMarkdown.trim() ||
      proposedMarkdown.length > SOP_NL_MARKDOWN_MAX ||
      typeof changeSummary !== "string" || !changeSummary.trim() ||
      changeSummary.length > 2_000 ||
      !Array.isArray(affectedSections) ||
      affectedSections.some((section) => typeof section !== "string" || section.length > 200) ||
      affectedSections.length > 50 ||
      !config) {
    throw new Error("NBJ_SOP_NL_DRAFT_INVALID");
  }
  return {
    proposedMarkdown: proposedMarkdown.trim(),
    config,
    changeSummary: changeSummary.trim(),
    affectedSections: affectedSections.map(String),
  };
}

function validateFreeFeedingConfig(config: Record<string, unknown>): void {
  const free = config.freeFeedingTemplate;
  if (free === undefined || free === null) return;
  const template = objectValue(free);
  if (!template) throw new Error("NBJ_FREE_FEEDING_SLOTS_INVALID");
  normalizeFreeFeedingSlots(
    Array.isArray(template.windows) ? template.windows : defaultFreeFeedingSlots(),
  );
}

function validateProposal(
  proposal: SopEditProposal,
  originalSha256: string | null,
): void {
  validateFreeFeedingConfig(proposal.config);
  try {
    parseSopMarkdown(proposal.proposedMarkdown);
  } catch {
    throw new Error("NBJ_SOP_NL_DRAFT_INVALID");
  }
  if (originalSha256 && sha256Text(proposal.proposedMarkdown) === originalSha256) {
    throw new Error("NBJ_SOP_NL_DRAFT_UNCHANGED");
  }
}

function isCompleteSopMarkdown(value: string): boolean {
  if (!/^#{1,6}\s+.+$/m.test(value)) return false;
  try {
    return parseSopMarkdown(value).chunks.length > 0;
  } catch {
    return false;
  }
}

function buildPrompt(task: SopEditTask, template: LocalSopTemplate | null): BaseMessage[] {
  const source = template
    ? `当前模板：${template.name}（版本 ${template.version}）\n\n完整 SOP Markdown：\n${template.sourceMarkdown}\n\n当前配置：\n${JSON.stringify(template.config, null, 2)}`
    : "这是新建模板请求，当前没有可参考的 SOP 原文。";
  return [
    new SystemMessage(`你是奶爸机 SOP 编辑助手。你只负责把管理员的自然语言指令翻译成可发布的 SOP 修改提案。
规则：
1. 只输出一个 JSON 对象，不要输出解释性文字。
2. JSON 字段固定为：proposedMarkdown（完整 SOP Markdown，字符串）、config（模板配置对象，可只包含需要改动的键）、changeSummary（200 字内中文摘要）、affectedSections（受影响的章节标题数组）。
3. 修改现有模板时必须保留与指令无关的全部章节和字段；只按指令调整。
4. 配置键使用既有字段名；自由采食时段使用 freeFeedingTemplate.windows。
5. 不得虚构批次数据、操作员记录或系统不支持的字段。`),
    new HumanMessage(`管理员指令：\n${task.instruction}\n\n${source}`),
  ];
}

export async function draftSopEdit(input: {
  store: LocalStore;
  model: SopEditModel;
  taskId: string;
}): Promise<SopEditTask> {
  const task = input.store.getSopEditTask(input.taskId);
  if (!task) throw new Error("NBJ_SOP_NL_TASK_NOT_FOUND");
  if (task.status !== "drafting") return task;
  try {
    const template = task.templateId ? input.store.getSopTemplate(task.templateId) : null;
    if (task.templateId && !template) throw new Error("NBJ_SOP_NL_TEMPLATE_NOT_FOUND");
    if (!template && isCompleteSopMarkdown(task.instruction)) {
      const parsed = parseSopMarkdown(task.instruction);
      const affectedSections = [...new Set(parsed.chunks.map((chunk) => chunk.title))];
      return input.store.completeSopEditTaskDraft({
        taskId: task.id,
        proposedMarkdown: task.instruction,
        proposedConfig: {},
        changeSummary: "新建 SOP 模板（直接使用粘贴的完整原文）",
        affectedSections,
      });
    }
    if (task.instruction.length > SOP_NL_LLM_INSTRUCTION_MAX) {
      throw new Error("NBJ_SOP_NL_INSTRUCTION_TOO_LONG");
    }
    const response = await input.model.invoke(buildPrompt(task, template), { callbacks: [] });
    const proposal = parseProposalJson(messageText(response));
    validateProposal(proposal, template?.sourceSha256 ?? null);
    const mergedConfig = template
      ? { ...template.config, ...proposal.config }
      : proposal.config;
    return input.store.completeSopEditTaskDraft({
      taskId: task.id,
      proposedMarkdown: proposal.proposedMarkdown,
      proposedConfig: mergedConfig,
      changeSummary: proposal.changeSummary,
      affectedSections: proposal.affectedSections,
    });
  } catch (error) {
    try {
      return input.store.failSopEditTaskDraft({
        taskId: task.id,
        errorCode: draftErrorCode(error),
      });
    } catch {
      if (error instanceof Error) throw error;
      throw new Error("NBJ_SOP_NL_DRAFT_FAILED");
    }
  }
}

export async function confirmSopEdit(input: {
  store: LocalStore;
  index: SopKnowledgeIndex;
  taskId: string;
  version: string;
  name: string;
  confirmationPhrase: string;
  confirmedBy: string;
}): Promise<{ task: SopEditTask; template: LocalSopTemplate }> {
  const task = input.store.getSopEditTask(input.taskId);
  if (!task) throw new Error("NBJ_SOP_NL_TASK_NOT_FOUND");
  if (task.status !== "draft_ready") throw new Error("NBJ_SOP_NL_TASK_NOT_DRAFT_READY");
  if (input.confirmationPhrase !== SOP_NL_CONFIRM_PHRASE) {
    throw new Error("NBJ_SOP_NL_CONFIRM_PHRASE_MISMATCH");
  }
  if (!task.proposedMarkdown || !task.proposedConfig) {
    throw new Error("NBJ_SOP_NL_TASK_NOT_DRAFT_READY");
  }
  const template = await publishSop({
    store: input.store,
    index: input.index,
    version: input.version,
    name: input.name,
    config: task.proposedConfig,
    sourceMarkdown: task.proposedMarkdown,
    createdBy: input.confirmedBy,
    sourceTemplateId: task.templateId,
  });
  const updated = input.store.publishSopEditTask({
    taskId: task.id,
    publishedTemplateId: template.id,
    confirmedBy: input.confirmedBy,
  });
  return { task: updated, template };
}
