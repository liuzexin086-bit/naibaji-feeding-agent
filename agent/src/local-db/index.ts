import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { normalizeIsoTimestamp, timestampOrderValue } from "../shared/iso-time.js";
import type {
  DeviceSetting,
  FeedingDecision,
  FeedingMode,
} from "../shared/agent-v2-contract.js";
import type {
  AgentMessage,
  AgentSession,
  AppendDailyObservationInput,
  AppendMessageInput,
  AuditEvent,
  AuditInput,
  BatchListOptions,
  CommitAdvanceInput,
  CommitModeSwitchInput,
  CommitRecordInput,
  CommitSopMigrationInput,
  CommitResult,
  CreateBatchInput,
  CreateSessionInput,
  DailyOperationAmendment,
  DailyOperationConfirmation,
  DailyOperationItem,
  DailyOperationPlan,
  DailyObservation,
  DecideDailyOperationAmendmentInput,
  EnsureDailyOperationAmendmentInput,
  FeedbackDeviceProposal,
  FeedbackOrigin,
  ConfirmDailyOperationPlanInput,
  EnsureDailyOperationPlanInput,
  ListMessagesOptions,
  LocalBatch,
  LocalSession,
  LocalSopTemplate,
  SopKnowledgeChunk,
  LocalStore,
  LocalStoreOptions,
  LocalUser,
  LocalUserRole,
  SaveDecisionInput,
  SopEditTask,
} from "../shared/local-store-contract.js";
import { INITIAL_SCHEMA, MIGRATION_VERSION } from "./schema.js";
import {
  materializeObservationFeedbackPlan,
  proposalToDeviceSetting,
} from "../operations/observation-feedback.js";

type Row = Record<string, unknown>;

export type LocalStoreErrorCode =
  | "LOCAL_STORE_CLOSED"
  | "LOCAL_STORE_BATCH_NOT_FOUND"
  | "LOCAL_STORE_BATCH_TERMINAL"
  | "LOCAL_STORE_DAILY_OPERATION_CONFIRMED"
  | "LOCAL_STORE_AMENDMENT_STALE"
  | "LOCAL_STORE_AMENDMENT_NOT_PENDING"
  | "LOCAL_STORE_AMENDMENT_CONFIRMATION_REQUIRED"
  | "LOCAL_STORE_AMENDMENT_ORIGIN_CONFLICT"
  | "LOCAL_STORE_AMENDMENT_MANUAL_ONLY"
  | "LOCAL_STORE_SESSION_NOT_FOUND"
  | "LOCAL_STORE_STALE_REVISION"
  | "LOCAL_STORE_IDEMPOTENCY_CONFLICT"
  | "LOCAL_STORE_DECISION_CONFLICT"
  | "LOCAL_STORE_USER_EXISTS"
  | "LOCAL_STORE_USER_NOT_FOUND"
  | "LOCAL_STORE_USER_SELF_DELETE"
  | "LOCAL_STORE_USER_CONFIRM_MISMATCH"
  | "LOCAL_STORE_LAST_ADMIN"
  | "LOCAL_STORE_INVALID_INPUT"
  | "LOCAL_STORE_INVALID_TIMESTAMP"
  | "LOCAL_STORE_MODE_SWITCH_AFTER_EXECUTION_BLOCKED"
  | "LOCAL_STORE_MODE_SWITCH_ACTUAL_UNKNOWN"
  | "LOCAL_STORE_MODE_SWITCH_AMENDMENT_PENDING";

export class LocalStoreError extends Error {
  constructor(
    public readonly code: LocalStoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "LocalStoreError";
  }
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `${field} is required`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalStoreError(
      "LOCAL_STORE_INVALID_INPUT",
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid database ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringValue(value, field);
}

function normalizedObservedAt(value: string | undefined): string {
  const normalized = normalizeIsoTimestamp(value ?? new Date().toISOString());
  if (!normalized) {
    throw new LocalStoreError(
      "LOCAL_STORE_INVALID_TIMESTAMP",
      "observedAt must be a valid ISO 8601 timestamp",
    );
  }
  return normalized;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid database ${field}`);
  }
  return value;
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  const text = stringValue(value, field);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid database ${field}`);
  }
  return parsed as Record<string, unknown>;
}

function nullableJsonObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return jsonObject(value, field);
}

function cumulativeActualFromRecords(records: unknown, dayIndex: number): number | null {
  if (!Array.isArray(records)) return null;
  const valid = records
    .filter((row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row) &&
      Number(row.dayIndex) === dayIndex &&
      normalizeIsoTimestamp(row.recordedAt ?? row.created_at) !== null)
    .sort((left, right) => {
      const leftAt = String(left.recordedAt ?? left.created_at ?? "");
      const rightAt = String(right.recordedAt ?? right.created_at ?? "");
      return timestampOrderValue(leftAt) - timestampOrderValue(rightAt);
    });
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const value = valid[index]?.actualPowderGrams;
    if (value !== undefined && value !== null && value !== "") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
      return null;
    }
  }
  return null;
}

function feedbackOriginKind(value: unknown, field: string): FeedbackOrigin["kind"] {
  if (value !== "diarrhea" && value !== "creep_control" && value !== "mode_change") {
    throw new Error(`Invalid database ${field}`);
  }
  return value;
}

function feedbackRefOf(value: unknown, field: string): NonNullable<DailyOperationItem["feedbackRef"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid database ${field}`);
  }
  const row = value as Record<string, unknown>;
  const kind = feedbackOriginKind(row.kind, `${field}.kind`);
  const originId = stringValue(row.originId, `${field}.originId`);
  const requiresDeviceConfirmation = row.requiresDeviceConfirmation;
  if (typeof requiresDeviceConfirmation !== "boolean") {
    throw new Error(`Invalid database ${field}.requiresDeviceConfirmation`);
  }
  const proposalDigest = row.proposalDigest;
  return {
    originId,
    kind,
    ...(proposalDigest === undefined || proposalDigest === null
      ? {}
      : { proposalDigest: stringValue(proposalDigest, `${field}.proposalDigest`) }),
    requiresDeviceConfirmation,
  };
}

function feedbackProposalOf(value: unknown, field: string): FeedbackDeviceProposal {
  const row = jsonObject(value, field);
  return row as unknown as FeedbackDeviceProposal;
}

function feedbackOriginOf(value: unknown, field: string): FeedbackOrigin {
  const row = jsonObject(value, field);
  return row as unknown as FeedbackOrigin;
}

function serializeObject(value: Record<string, unknown>, field: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `${field} must be an object`);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `${field} is not serializable`);
  }
  return serialized;
}

function nullableJsonParam(value: unknown, existingValue: unknown): string | null {
  if (value === undefined) {
    return existingValue == null ? null : JSON.stringify(existingValue);
  }
  return value == null ? null : JSON.stringify(value);
}

function serializeDecision(decision: FeedingDecision): string {
  const serialized = JSON.stringify(decision);
  if (serialized === undefined) {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "decision is not serializable");
  }
  return serialized;
}

function batchFromRow(row: Row): LocalBatch {
  return {
    userId: stringValue(row.user_id, "batches.user_id"),
    batchId: stringValue(row.id, "batches.id"),
    revision: numberValue(row.revision, "batches.revision"),
    currentDay: numberValue(row.current_day, "batches.current_day"),
    status: stringValue(row.status, "batches.status"),
    data: jsonObject(row.data_json, "batches.data_json"),
    createdAt: stringValue(row.created_at, "batches.created_at"),
    updatedAt: stringValue(row.updated_at, "batches.updated_at"),
  };
}

function observationFromRow(row: Row): DailyObservation {
  return {
    id: stringValue(row.id, "daily_observations.id"),
    userId: stringValue(row.user_id, "daily_observations.user_id"),
    batchId: stringValue(row.batch_id, "daily_observations.batch_id"),
    dateLocal: stringValue(row.date_local, "daily_observations.date_local"),
    observedAt: stringValue(row.observed_at, "daily_observations.observed_at"),
    batchRevision: numberValue(row.batch_revision, "daily_observations.batch_revision"),
    data: jsonObject(row.data_json, "daily_observations.data_json"),
    idempotencyKey: stringValue(
      row.idempotency_key,
      "daily_observations.idempotency_key",
    ),
    createdAt: stringValue(row.created_at, "daily_observations.created_at"),
  };
}

function sessionFromRow(row: Row): AgentSession {
  const status = stringValue(row.status, "agent_sessions.status");
  if (status !== "active" && status !== "closed") {
    throw new Error("Invalid database agent_sessions.status");
  }
  return {
    id: stringValue(row.id, "agent_sessions.id"),
    userId: stringValue(row.user_id, "agent_sessions.user_id"),
    batchId: stringValue(row.batch_id, "agent_sessions.batch_id"),
    status,
    provider: nullableString(row.provider, "agent_sessions.provider"),
    model: nullableString(row.model, "agent_sessions.model"),
    createdAt: stringValue(row.created_at, "agent_sessions.created_at"),
    updatedAt: stringValue(row.updated_at, "agent_sessions.updated_at"),
  };
}

function messageFromRow(row: Row): AgentMessage {
  const role = stringValue(row.role, "agent_messages.role");
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") {
    throw new Error("Invalid database agent_messages.role");
  }
  return {
    id: stringValue(row.id, "agent_messages.id"),
    userId: stringValue(row.user_id, "agent_messages.user_id"),
    batchId: stringValue(row.batch_id, "agent_messages.batch_id"),
    sessionId: stringValue(row.session_id, "agent_messages.session_id"),
    role,
    content: stringValue(row.content, "agent_messages.content"),
    toolName: nullableString(row.tool_name, "agent_messages.tool_name"),
    toolCallId: nullableString(row.tool_call_id, "agent_messages.tool_call_id"),
    evidence: jsonObject(row.evidence_json, "agent_messages.evidence_json"),
    createdAt: stringValue(row.created_at, "agent_messages.created_at"),
  };
}

function auditFromRow(row: Row): AuditEvent {
  return {
    id: stringValue(row.id, "audit_events.id"),
    userId: stringValue(row.user_id, "audit_events.user_id"),
    batchId: nullableString(row.batch_id, "audit_events.batch_id"),
    action: stringValue(row.action, "audit_events.action"),
    details: jsonObject(row.details_json, "audit_events.details_json"),
    createdAt: stringValue(row.created_at, "audit_events.created_at"),
  };
}

function decisionFromRow(row: Row): FeedingDecision {
  return JSON.parse(stringValue(row.decision_json, "feeding_decisions.decision_json")) as FeedingDecision;
}

function userFromRow(row: Row): LocalUser {
  const role = stringValue(row.role ?? "operator", "users.role");
  if (role !== "admin" && role !== "operator") throw new Error("Invalid database users.role");
  return {
    id: stringValue(row.id, "users.id"),
    // Legacy batches may have created an owner row before local auth was
    // enabled. Keep those rows visible to account administration without
    // treating a missing credential as a database corruption.
    email: row.email === null || row.email === undefined ? "" : stringValue(row.email, "users.email"),
    role: role as LocalUserRole,
    createdAt: stringValue(row.created_at, "users.created_at"),
    disabled: Number(row.disabled ?? 0) === 1,
  };
}

function authSessionFromRow(row: Row): LocalSession {
  return {
    id: stringValue(row.id, "auth_sessions.id"),
    userId: stringValue(row.user_id, "auth_sessions.user_id"),
    tokenHash: stringValue(row.token_hash, "auth_sessions.token_hash"),
    expiresAt: stringValue(row.expires_at, "auth_sessions.expires_at"),
    revokedAt: nullableString(row.revoked_at, "auth_sessions.revoked_at"),
    createdAt: stringValue(row.created_at, "auth_sessions.created_at"),
  };
}

function sopTemplateFromRow(row: Row): LocalSopTemplate {
  return {
    id: stringValue(row.id, "sop_templates.id"),
    version: stringValue(row.version, "sop_templates.version"),
    name: stringValue(row.name, "sop_templates.name"),
    config: jsonObject(row.config_json, "sop_templates.config_json"),
    createdBy: stringValue(row.created_by, "sop_templates.created_by"),
    sourceTemplateId: nullableString(row.source_template_id, "sop_templates.source_template_id"),
    createdAt: stringValue(row.created_at, "sop_templates.created_at"),
    status: stringValue(row.status ?? "draft", "sop_templates.status") as LocalSopTemplate["status"],
    sourceMarkdown: stringValue(row.source_markdown ?? "", "sop_templates.source_markdown"),
    sourceSha256: stringValue(row.source_sha256 ?? "", "sop_templates.source_sha256"),
    collectionRevision: stringValue(row.collection_revision ?? "", "sop_templates.collection_revision"),
    parserVersion: stringValue(row.parser_version ?? "", "sop_templates.parser_version"),
    embeddingModel: stringValue(row.embedding_model ?? "", "sop_templates.embedding_model"),
    chunkCount: numberValue(row.chunk_count ?? 0, "sop_templates.chunk_count"),
    publishedAt: nullableString(row.published_at ?? null, "sop_templates.published_at"),
    indexError: nullableString(row.index_error ?? null, "sop_templates.index_error"),
  };
}

function sopEditTaskFromRow(row: Row): SopEditTask {
  return {
    id: stringValue(row.id, "sop_edit_tasks.id"),
    templateId: nullableString(row.template_id, "sop_edit_tasks.template_id"),
    instruction: stringValue(row.instruction, "sop_edit_tasks.instruction"),
    status: stringValue(row.status, "sop_edit_tasks.status") as SopEditTask["status"],
    proposedMarkdown: nullableString(row.proposed_markdown ?? null, "sop_edit_tasks.proposed_markdown"),
    proposedConfig: row.proposed_config_json == null
      ? null
      : jsonObject(row.proposed_config_json, "sop_edit_tasks.proposed_config_json"),
    changeSummary: nullableString(row.change_summary ?? null, "sop_edit_tasks.change_summary"),
    affectedSections: row.affected_sections_json == null
      ? []
      : stringArrayValue(row.affected_sections_json, "sop_edit_tasks.affected_sections_json"),
    errorCode: nullableString(row.error_code ?? null, "sop_edit_tasks.error_code"),
    publishedTemplateId: nullableString(row.published_template_id, "sop_edit_tasks.published_template_id"),
    createdBy: stringValue(row.created_by, "sop_edit_tasks.created_by"),
    confirmedBy: nullableString(row.confirmed_by, "sop_edit_tasks.confirmed_by"),
    createdAt: stringValue(row.created_at, "sop_edit_tasks.created_at"),
    updatedAt: stringValue(row.updated_at, "sop_edit_tasks.updated_at"),
    confirmedAt: nullableString(row.confirmed_at ?? null, "sop_edit_tasks.confirmed_at"),
  };
}

function stringArrayValue(value: unknown, field: string): string[] {
  const parsed: unknown = JSON.parse(stringValue(value, field));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid database ${field}`);
  }
  return parsed;
}

function businessDate(value: string, field: string): string {
  const date = requiredText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `${field} must be YYYY-MM-DD`);
  }
  return date;
}

function sha256(value: string, field: string): string {
  const digest = requiredText(value, field).toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(digest)) {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `${field} must be a SHA-256 digest`);
  }
  return digest;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function legacyFrozenSopSnapshotDigest(snapshot: Record<string, unknown>): string | null {
  const templateId = typeof snapshot.templateId === "string" ? snapshot.templateId.trim() : "";
  const version = typeof snapshot.version === "string" ? snapshot.version.trim() : "";
  const sourceSha256 = typeof snapshot.sourceSha256 === "string" ? snapshot.sourceSha256.toUpperCase() : "";
  const collectionRevision = typeof snapshot.collectionRevision === "string" ? snapshot.collectionRevision.trim() : "";
  const parserVersion = typeof snapshot.parserVersion === "string" ? snapshot.parserVersion.trim() : "";
  const embeddingModel = typeof snapshot.embeddingModel === "string" ? snapshot.embeddingModel.trim() : "";
  const config = objectValue(snapshot.config);
  if (!templateId || !version || !/^[A-F0-9]{64}$/.test(sourceSha256) ||
      !collectionRevision || !parserVersion || !embeddingModel || !config) return null;
  const immutable = {
    templateId,
    version,
    sourceSha256,
    collectionRevision,
    parserVersion,
    embeddingModel,
    config,
  };
  return createHash("sha256").update(JSON.stringify(immutable).normalize("NFC"), "utf8").digest("hex").toUpperCase();
}

function legacyFreeFeedingSlots(windows: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(windows) || windows.length > 8) return null;
  const slots = Array.from({ length: 8 }, (_, index) => ({
    slot: index + 1,
    enabled: false,
    label: `自由采食时段 ${index + 1}`,
    startLocal: "09:00",
    endLocal: "10:00",
  }));
  for (const [index, window] of windows.entries()) {
    const row = objectValue(window);
    const startLocal = typeof row?.startLocal === "string" ? row.startLocal : "";
    const endLocal = typeof row?.endLocal === "string" ? row.endLocal : "";
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startLocal) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endLocal)) return null;
    slots[index] = {
      slot: index + 1,
      enabled: true,
      label: `自由采食时段 ${index + 1}`,
      startLocal,
      endLocal,
    };
  }
  return slots;
}

function legacyDevicePlanDigest(snapshot: Record<string, unknown>): string | null {
  const version = typeof snapshot.version === "string" ? snapshot.version : "";
  const firstDay = objectValue(snapshot.firstDay);
  const templates = objectValue(snapshot.templates);
  if (!version || !firstDay || !templates) return null;
  const immutable = { version, firstDay, templates };
  return createHash("sha256").update(JSON.stringify(immutable).normalize("NFC"), "utf8").digest("hex").toUpperCase();
}

function dailyOperationItems(value: DailyOperationItem[]): DailyOperationItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "operations are required");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `operations[${index}] is invalid`);
    }
    const dueWindow = item.dueWindow;
    if (!dueWindow || typeof dueWindow !== "object" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueWindow.startLocal) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueWindow.endLocal) ||
        (dueWindow.endDayOffset !== undefined && dueWindow.endDayOffset !== 0 && dueWindow.endDayOffset !== 1)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `operations[${index}].dueWindow is invalid`);
    }
    if (!Array.isArray(item.requiredObservationFields) || !Array.isArray(item.safetyNotes)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `operations[${index}] list fields are invalid`);
    }
    return {
      code: requiredText(item.code, `operations[${index}].code`),
      title: requiredText(item.title, `operations[${index}].title`),
      dueWindow: {
        startLocal: dueWindow.startLocal,
        endLocal: dueWindow.endLocal,
        ...(dueWindow.endDayOffset === undefined ? {} : { endDayOffset: dueWindow.endDayOffset }),
      },
      sopSection: requiredText(item.sopSection, `operations[${index}].sopSection`),
      requiredObservationFields: item.requiredObservationFields.map((entry, fieldIndex) =>
        requiredText(entry, `operations[${index}].requiredObservationFields[${fieldIndex}]`)),
      safetyNotes: item.safetyNotes.map((entry, fieldIndex) =>
        requiredText(entry, `operations[${index}].safetyNotes[${fieldIndex}]`)),
      ...(item.feedbackRef === undefined
        ? {}
        : { feedbackRef: feedbackRefOf(item.feedbackRef, `operations[${index}].feedbackRef`) }),
    };
  });
}

function digestDailyOperations(operations: DailyOperationItem[]): string {
  return createHash("sha256")
    .update(JSON.stringify(operations).normalize("NFC"), "utf8")
    .digest("hex")
    .toUpperCase();
}

function dailyOperationMode(value: FeedingMode, field: string): FeedingMode {
  if (value !== "timed_quantity" && value !== "free_feeding") {
    throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function operationItemsFromJson(value: unknown, field: string): DailyOperationItem[] {
  const parsed: unknown = JSON.parse(stringValue(value, field));
  if (!Array.isArray(parsed)) throw new Error(`Invalid database ${field}`);
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid database ${field}`);
    const row = item as Record<string, unknown>;
    const dueWindow = row.dueWindow;
    if (!dueWindow || typeof dueWindow !== "object" || Array.isArray(dueWindow)) {
      throw new Error(`Invalid database ${field}`);
    }
    const window = dueWindow as Record<string, unknown>;
    const startLocal = stringValue(window.startLocal, `${field}.dueWindow.startLocal`);
    const endLocal = stringValue(window.endLocal, `${field}.dueWindow.endLocal`);
    const endDayOffset = window.endDayOffset;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startLocal) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endLocal) ||
        (endDayOffset !== undefined && endDayOffset !== 0 && endDayOffset !== 1)) {
      throw new Error(`Invalid database ${field}.dueWindow`);
    }
    return {
      code: stringValue(row.code, `${field}.code`),
      title: stringValue(row.title, `${field}.title`),
      dueWindow: {
        startLocal,
        endLocal,
        ...(endDayOffset === undefined ? {} : { endDayOffset: endDayOffset as 0 | 1 }),
      },
      sopSection: stringValue(row.sopSection, `${field}.sopSection`),
      requiredObservationFields: Array.isArray(row.requiredObservationFields)
        ? row.requiredObservationFields.map((entry) => stringValue(entry, `${field}.requiredObservationFields`)) : [],
      safetyNotes: Array.isArray(row.safetyNotes)
        ? row.safetyNotes.map((entry) => stringValue(entry, `${field}.safetyNotes`)) : [],
      ...(row.feedbackRef === undefined || row.feedbackRef === null
        ? {}
        : { feedbackRef: feedbackRefOf(row.feedbackRef, `${field}.feedbackRef`) }),
    };
  });
}

function dailyOperationPlanFromRow(row: Row): DailyOperationPlan {
  const status = stringValue(row.status, "daily_operation_plans.status");
  if (status !== "pending" && status !== "confirmed") throw new Error("Invalid database daily_operation_plans.status");
  const selectedMode = stringValue(row.selected_mode, "daily_operation_plans.selected_mode");
  const effectiveMode = stringValue(row.effective_mode, "daily_operation_plans.effective_mode");
  if ((selectedMode !== "timed_quantity" && selectedMode !== "free_feeding") ||
      (effectiveMode !== "timed_quantity" && effectiveMode !== "free_feeding")) {
    throw new Error("Invalid database daily_operation_plans.mode");
  }
  return {
    id: stringValue(row.id, "daily_operation_plans.id"),
    userId: stringValue(row.user_id, "daily_operation_plans.user_id"),
    batchId: stringValue(row.batch_id, "daily_operation_plans.batch_id"),
    businessDate: stringValue(row.business_date, "daily_operation_plans.business_date"),
    basedOnBatchRevision: numberValue(row.based_on_batch_revision, "daily_operation_plans.based_on_batch_revision"),
    sopTemplateId: stringValue(row.sop_template_id, "daily_operation_plans.sop_template_id"),
    sopSourceSha256: stringValue(row.sop_source_sha256, "daily_operation_plans.sop_source_sha256"),
    devicePlanVersion: stringValue(row.device_plan_version, "daily_operation_plans.device_plan_version"),
    devicePlanSha256: stringValue(row.device_plan_sha256, "daily_operation_plans.device_plan_sha256"),
    selectedMode: selectedMode,
    effectiveMode,
    operations: operationItemsFromJson(row.operations_json, "daily_operation_plans.operations_json"),
    operationsSha256: stringValue(row.operations_sha256, "daily_operation_plans.operations_sha256"),
    status,
    proposedSetting: row.proposed_setting_json == null
      ? null
      : feedbackProposalOf(row.proposed_setting_json, "daily_operation_plans.proposed_setting_json"),
    feedbackOrigin: row.feedback_origin_json == null
      ? null
      : feedbackOriginOf(row.feedback_origin_json, "daily_operation_plans.feedback_origin_json"),
    createdAt: stringValue(row.created_at, "daily_operation_plans.created_at"),
  };
}

function dailyOperationConfirmationFromRow(row: Row): DailyOperationConfirmation {
  const deviceSettingRow = nullableJsonObject(
    row.device_setting_json,
    "daily_operation_confirmations.device_setting_json",
  );
  return {
    id: stringValue(row.id, "daily_operation_confirmations.id"),
    planId: stringValue(row.plan_id, "daily_operation_confirmations.plan_id"),
    userId: stringValue(row.user_id, "daily_operation_confirmations.user_id"),
    batchId: stringValue(row.batch_id, "daily_operation_confirmations.batch_id"),
    businessDate: stringValue(row.business_date, "daily_operation_confirmations.business_date"),
    operationsSha256: stringValue(row.operations_sha256, "daily_operation_confirmations.operations_sha256"),
    confirmedBy: stringValue(row.confirmed_by, "daily_operation_confirmations.confirmed_by"),
    confirmedAt: stringValue(row.confirmed_at, "daily_operation_confirmations.confirmed_at"),
    idempotencyKey: stringValue(row.idempotency_key, "daily_operation_confirmations.idempotency_key"),
    deviceSetting: deviceSettingRow as DeviceSetting | null,
    decisionId: row.decision_id == null ? null : stringValue(row.decision_id, "daily_operation_confirmations.decision_id"),
  };
}

function dailyOperationAmendmentFromRow(row: Row): DailyOperationAmendment {
  const originKind = stringValue(row.origin_kind, "daily_operation_amendments.origin_kind");
  const severity = row.severity == null
    ? null
    : stringValue(row.severity, "daily_operation_amendments.severity");
  const priority = stringValue(row.priority, "daily_operation_amendments.priority");
  const status = stringValue(row.status, "daily_operation_amendments.status");
  if (originKind !== "diarrhea" && originKind !== "creep_control" && originKind !== "mode_change") {
    throw new Error("Invalid database daily_operation_amendments.origin_kind");
  }
  if (severity !== null && severity !== "mild" && severity !== "moderate" && severity !== "severe") {
    throw new Error("Invalid database daily_operation_amendments.severity");
  }
  if (priority !== "routine" && priority !== "warning" && priority !== "critical") {
    throw new Error("Invalid database daily_operation_amendments.priority");
  }
  if (status !== "pending" && status !== "confirmed" &&
      status !== "rejected" && status !== "applied" &&
      status !== "superseded" && status !== "cancelled") {
    throw new Error("Invalid database daily_operation_amendments.status");
  }
  return {
    id: stringValue(row.id, "daily_operation_amendments.id"),
    userId: stringValue(row.user_id, "daily_operation_amendments.user_id"),
    batchId: stringValue(row.batch_id, "daily_operation_amendments.batch_id"),
    businessDate: stringValue(row.business_date, "daily_operation_amendments.business_date"),
    basePlanId: stringValue(row.base_plan_id, "daily_operation_amendments.base_plan_id"),
    baseConfirmationId: row.base_confirmation_id == null
      ? null
      : stringValue(row.base_confirmation_id, "daily_operation_amendments.base_confirmation_id"),
    originId: stringValue(row.origin_id, "daily_operation_amendments.origin_id"),
    originKind,
    severity,
    priority,
    status,
    operations: operationItemsFromJson(
      row.operations_json,
      "daily_operation_amendments.operations_json",
    ),
    proposal: row.proposal_json == null
      ? null
      : feedbackProposalOf(row.proposal_json, "daily_operation_amendments.proposal_json"),
    decisionId: row.decision_id == null
      ? null
      : stringValue(row.decision_id, "daily_operation_amendments.decision_id"),
    amendmentSha256: stringValue(
      row.amendment_sha256,
      "daily_operation_amendments.amendment_sha256",
    ),
    basedOnBatchRevision: numberValue(
      row.based_on_batch_revision,
      "daily_operation_amendments.based_on_batch_revision",
    ),
    idempotencyKey: stringValue(
      row.idempotency_key,
      "daily_operation_amendments.idempotency_key",
    ),
    createdAt: stringValue(row.created_at, "daily_operation_amendments.created_at"),
    decidedAt: row.decided_at == null ? null : stringValue(row.decided_at, "daily_operation_amendments.decided_at"),
    decidedBy: row.decided_by == null ? null : stringValue(row.decided_by, "daily_operation_amendments.decided_by"),
  };
}

function amendmentSha256(
  operations: DailyOperationItem[],
  proposal: FeedbackDeviceProposal | null,
  basedOnBatchRevision: number,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      operations,
      proposal,
      basedOnBatchRevision,
      schema: "daily-operation-amendment-v1",
    }).normalize("NFC"), "utf8")
    .digest("hex")
    .toUpperCase();
}

function sopChunkFromRow(row: Row): SopKnowledgeChunk {
  const terms = JSON.parse(stringValue(row.lexical_terms_json, "sop_knowledge_chunks.lexical_terms_json")) as unknown;
  if (!Array.isArray(terms) || !terms.every((term) => typeof term === "string")) {
    throw new Error("Invalid database sop_knowledge_chunks.lexical_terms_json");
  }
  return {
    templateId: stringValue(row.template_id, "sop_knowledge_chunks.template_id"),
    chunkId: stringValue(row.chunk_id, "sop_knowledge_chunks.chunk_id"),
    sectionId: stringValue(row.section_id, "sop_knowledge_chunks.section_id"),
    chunkIndex: numberValue(row.chunk_index, "sop_knowledge_chunks.chunk_index"),
    title: stringValue(row.title, "sop_knowledge_chunks.title"),
    text: stringValue(row.text, "sop_knowledge_chunks.text"),
    sourceSha256: stringValue(row.source_sha256, "sop_knowledge_chunks.source_sha256"),
    collectionRevision: stringValue(row.collection_revision, "sop_knowledge_chunks.collection_revision"),
    lexicalTerms: terms,
  };
}

function resultFromJson(value: string): CommitResult {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return { replayed: true, result: parsed };
}

function isMemoryFilename(filename: string): boolean {
  return filename === ":memory:" || filename.includes("mode=memory");
}

export class SqliteLocalStore implements LocalStore {
  readonly #database: DatabaseSync;
  #closed = false;
  #transactionDepth = 0;
  #lastMessageCreatedAtMs = 0;

  constructor(options: LocalStoreOptions) {
    const filename = requiredText(options.filename, "filename");
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (!isMemoryFilename(filename)) this.#database.exec("PRAGMA journal_mode = WAL;");
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  migrate(): void {
    this.#ensureOpen();
    return this.#transaction(() => {
      this.#preflightDuplicateActiveDecisions();
      this.#database.exec(INITIAL_SCHEMA);
      this.#ensureAmendmentV10();
      this.#ensureAmendmentActionCancelV11();
      this.#ensureModeChangeV12();
      const appliesFrozenSopDigestBackfill = !this.#database.prepare(
        "SELECT 1 FROM schema_migrations WHERE version = ?",
      ).get(MIGRATION_VERSION);
      // Existing development volumes may contain the pre-auth users table.
      // The product no longer migrates business data, but adding nullable
      // credential columns keeps a restart safe without copying or exposing
      // any legacy records.
      const columns = new Set(
        (this.#database.prepare("PRAGMA table_info(users)").all() as Row[])
          .map((row) => String(row.name)),
      );
      for (const [name, definition] of [
        ["email", "TEXT"],
        ["password_hash", "TEXT"],
        ["password_salt", "TEXT"],
        ["role", "TEXT NOT NULL DEFAULT 'operator'"],
        ["disabled", "INTEGER NOT NULL DEFAULT 0"],
      ] as const) {
        if (!columns.has(name)) {
          this.#database.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
        }
      }
      const sopColumns = new Set(
        (this.#database.prepare("PRAGMA table_info(sop_templates)").all() as Row[])
          .map((row) => String(row.name)),
      );
      for (const [name, definition] of [
        ["status", "TEXT NOT NULL DEFAULT 'draft'"],
        ["source_markdown", "TEXT NOT NULL DEFAULT ''"],
        ["source_sha256", "TEXT NOT NULL DEFAULT ''"],
        ["collection_revision", "TEXT NOT NULL DEFAULT ''"],
        ["parser_version", "TEXT NOT NULL DEFAULT ''"],
        ["embedding_model", "TEXT NOT NULL DEFAULT ''"],
        ["chunk_count", "INTEGER NOT NULL DEFAULT 0"],
        ["published_at", "TEXT"],
        ["index_error", "TEXT"],
      ] as const) {
        if (!sopColumns.has(name)) {
          this.#database.exec(`ALTER TABLE sop_templates ADD COLUMN ${name} ${definition}`);
        }
      }
      const planColumns = new Set(
        (this.#database.prepare("PRAGMA table_info(daily_operation_plans)").all() as Row[])
          .map((row) => String(row.name)),
      );
      for (const [name, definition] of [
        ["proposed_setting_json", "TEXT"],
        ["feedback_origin_json", "TEXT"],
      ] as const) {
        if (!planColumns.has(name)) {
          this.#database.exec(`ALTER TABLE daily_operation_plans ADD COLUMN ${name} ${definition}`);
        }
      }
      const confirmationColumns = new Set(
        (this.#database.prepare("PRAGMA table_info(daily_operation_confirmations)").all() as Row[])
          .map((row) => String(row.name)),
      );
      for (const [name, definition] of [
        ["device_setting_json", "TEXT"],
        ["decision_id", "TEXT"],
      ] as const) {
        if (!confirmationColumns.has(name)) {
          this.#database.exec(`ALTER TABLE daily_operation_confirmations ADD COLUMN ${name} ${definition}`);
        }
      }
      this.#database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx
          ON users(email) WHERE email IS NOT NULL;
      `);
      if (appliesFrozenSopDigestBackfill) this.#backfillLegacyFrozenSnapshots();
      this.#database.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(MIGRATION_VERSION, new Date().toISOString());
    });
  }

  #preflightDuplicateActiveDecisions(): void {
    const tableExists = Boolean(this.#database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feeding_decisions'
    `).get());
    if (!tableExists) return;
    const duplicateActive = this.#database.prepare(`
      SELECT user_id, batch_id, date_local, COUNT(*) AS count
      FROM feeding_decisions
      WHERE status = 'active'
      GROUP BY user_id, batch_id, date_local
      HAVING COUNT(*) > 1
    `).all() as Row[];
    if (duplicateActive.length > 0) {
      throw new LocalStoreError(
        "LOCAL_STORE_INVALID_INPUT",
        "migration V12 preflight found duplicate active decisions",
      );
    }
  }

  #ensureAmendmentV10(): void {
    const columns = new Map(
      (this.#database.prepare("PRAGMA table_info(daily_operation_amendments)").all() as Row[])
        .map((row) => [String(row.name), row]),
    );
    const severity = columns.get("severity");
    const tableSql = String(
      (this.#database.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'daily_operation_amendments'
      `).get() as Row | undefined)?.sql ?? "",
    );
    const needsRebuild = !columns.has("priority") ||
      (severity !== undefined && Number(severity.notnull) === 1) ||
      !tableSql.includes("superseded") ||
      !tableSql.includes("cancelled");
    const amendmentCountBefore = Number(
      (this.#database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendments",
      ).get() as Row).count,
    );
    const actionTableExists = Boolean(this.#database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
    `).get());
    const actionCountBefore = actionTableExists
      ? Number((this.#database.prepare(
          "SELECT count(*) AS count FROM daily_operation_amendment_actions",
        ).get() as Row).count)
      : 0;
    if (needsRebuild) {
      if (actionTableExists) {
        this.#database.exec(`
          DROP TABLE IF EXISTS daily_operation_amendment_actions_v10_backup;
          CREATE TABLE daily_operation_amendment_actions_v10_backup (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            amendment_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply')),
            idempotency_key TEXT NOT NULL,
            expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
            expected_amendment_sha256 TEXT NOT NULL,
            resulting_status TEXT NOT NULL,
            decision_id TEXT,
            response_json TEXT NOT NULL CHECK (json_valid(response_json)),
            created_at TEXT NOT NULL,
            UNIQUE (user_id, idempotency_key)
          ) STRICT;
          INSERT INTO daily_operation_amendment_actions_v10_backup (
            id, user_id, batch_id, amendment_id, action, idempotency_key,
            expected_batch_revision, expected_amendment_sha256, resulting_status,
            decision_id, response_json, created_at
          )
          SELECT
            id, user_id, batch_id, amendment_id, action, idempotency_key,
            expected_batch_revision, expected_amendment_sha256, resulting_status,
            decision_id, response_json, created_at
          FROM daily_operation_amendment_actions;
          DROP TABLE daily_operation_amendment_actions;
        `);
      }
      this.#database.exec(`
        CREATE TABLE daily_operation_amendments_v9 (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          business_date TEXT NOT NULL,
          base_plan_id TEXT NOT NULL,
          base_confirmation_id TEXT,
          origin_id TEXT NOT NULL,
          origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control')),
          severity TEXT CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
          priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'warning', 'critical')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied', 'superseded', 'cancelled')),
          operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
          proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
          decision_id TEXT,
          amendment_sha256 TEXT NOT NULL,
          based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT,
          UNIQUE (user_id, origin_id),
          UNIQUE (user_id, idempotency_key),
          FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
          FOREIGN KEY (base_plan_id) REFERENCES daily_operation_plans(id) ON DELETE CASCADE,
          FOREIGN KEY (base_confirmation_id) REFERENCES daily_operation_confirmations(id) ON DELETE SET NULL,
          FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
        ) STRICT;
        INSERT INTO daily_operation_amendments_v9 (
          id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
          origin_id, origin_kind, severity, priority, status, operations_json,
          proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
          idempotency_key, created_at, decided_at, decided_by
        )
        SELECT
          id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
          origin_id, origin_kind, severity,
          CASE severity WHEN 'severe' THEN 'critical' WHEN 'moderate' THEN 'warning' ELSE 'routine' END,
          status, operations_json, proposal_json, decision_id, amendment_sha256,
          based_on_batch_revision, idempotency_key, created_at, decided_at, decided_by
        FROM daily_operation_amendments;
        DROP TABLE daily_operation_amendments;
        ALTER TABLE daily_operation_amendments_v9 RENAME TO daily_operation_amendments;
      `);
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS daily_operation_amendment_actions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        amendment_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
        idempotency_key TEXT NOT NULL,
        expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
        expected_amendment_sha256 TEXT NOT NULL,
        resulting_status TEXT NOT NULL,
        decision_id TEXT,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (amendment_id) REFERENCES daily_operation_amendments(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS daily_operation_amendment_actions_amendment_idx
        ON daily_operation_amendment_actions(amendment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS daily_operation_amendments_batch_date_idx
        ON daily_operation_amendments(user_id, batch_id, business_date DESC);
    `);
    const backupExists = Boolean(this.#database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendment_actions_v10_backup'
    `).get());
    if (backupExists) {
      this.#database.exec(`
        INSERT INTO daily_operation_amendment_actions (
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        )
        SELECT
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        FROM daily_operation_amendment_actions_v10_backup;
        DROP TABLE daily_operation_amendment_actions_v10_backup;
      `);
    }
    const amendmentCountAfter = Number(
      (this.#database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendments",
      ).get() as Row).count,
    );
    const actionCountAfter = Number(
      (this.#database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendment_actions",
      ).get() as Row).count,
    );
    if (
      amendmentCountBefore !== amendmentCountAfter ||
      actionCountBefore !== actionCountAfter
    ) {
      throw new LocalStoreError(
        "LOCAL_STORE_INVALID_INPUT",
        "amendment migration would lose rows; transaction rolled back",
      );
    }
  }

  #ensureAmendmentActionCancelV11(): void {
    const tableSql = String(
      (this.#database.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
      `).get() as Row | undefined)?.sql ?? "",
    );
    if (tableSql.includes("'cancel'")) return;
    this.#database.exec(`
      DROP TABLE IF EXISTS daily_operation_amendment_actions_v11_backup;
      CREATE TABLE daily_operation_amendment_actions_v11_backup (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        amendment_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
        idempotency_key TEXT NOT NULL,
        expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
        expected_amendment_sha256 TEXT NOT NULL,
        resulting_status TEXT NOT NULL,
        decision_id TEXT,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      ) STRICT;
      INSERT INTO daily_operation_amendment_actions_v11_backup (
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      )
      SELECT
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      FROM daily_operation_amendment_actions;
      DROP TABLE daily_operation_amendment_actions;
      CREATE TABLE daily_operation_amendment_actions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        amendment_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
        idempotency_key TEXT NOT NULL,
        expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
        expected_amendment_sha256 TEXT NOT NULL,
        resulting_status TEXT NOT NULL,
        decision_id TEXT,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (amendment_id) REFERENCES daily_operation_amendments(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO daily_operation_amendment_actions (
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      )
      SELECT
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      FROM daily_operation_amendment_actions_v11_backup;
      CREATE INDEX IF NOT EXISTS daily_operation_amendment_actions_amendment_idx
        ON daily_operation_amendment_actions(amendment_id, created_at DESC);
      DROP TABLE daily_operation_amendment_actions_v11_backup;
    `);
  }

  #ensureModeChangeV12(): void {
    const duplicateActive = this.#database.prepare(`
      SELECT user_id, batch_id, date_local, COUNT(*) AS count
      FROM feeding_decisions
      WHERE status = 'active'
      GROUP BY user_id, batch_id, date_local
      HAVING COUNT(*) > 1
    `).all() as Row[];
    if (duplicateActive.length > 0) {
      throw new LocalStoreError(
        "LOCAL_STORE_INVALID_INPUT",
        "migration V12 preflight found duplicate active decisions",
      );
    }

    const amendmentSql = String(
      (this.#database.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'daily_operation_amendments'
      `).get() as Row | undefined)?.sql ?? "",
    );
    const needsRebuild = !amendmentSql.includes("mode_change");
    const actionTableExists = Boolean(this.#database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
    `).get());
    const amendmentCountBefore = Number(
      (this.#database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendments",
      ).get() as Row).count,
    );
    const actionCountBefore = actionTableExists
      ? Number((this.#database.prepare(
          "SELECT count(*) AS count FROM daily_operation_amendment_actions",
        ).get() as Row).count)
      : 0;
    const payloadHash = (table: string, columns: string[]): string => {
      const rows = this.#database.prepare(
        `SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`,
      ).all() as Row[];
      return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
    };
    const amendmentHashBefore = payloadHash(
      "daily_operation_amendments",
      ["id", "origin_kind", "status", "amendment_sha256", "based_on_batch_revision"],
    );
    const actionHashBefore = actionTableExists
      ? payloadHash(
          "daily_operation_amendment_actions",
          ["id", "amendment_id", "action", "expected_amendment_sha256", "resulting_status"],
        )
      : "";

    if (needsRebuild) {
      if (actionTableExists) {
        this.#database.exec(`
          DROP TABLE IF EXISTS daily_operation_amendment_actions_v12_backup;
          CREATE TABLE daily_operation_amendment_actions_v12_backup (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            amendment_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
            idempotency_key TEXT NOT NULL,
            expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
            expected_amendment_sha256 TEXT NOT NULL,
            resulting_status TEXT NOT NULL,
            decision_id TEXT,
            response_json TEXT NOT NULL CHECK (json_valid(response_json)),
            created_at TEXT NOT NULL,
            UNIQUE (user_id, idempotency_key)
          ) STRICT;
          INSERT INTO daily_operation_amendment_actions_v12_backup (
            id, user_id, batch_id, amendment_id, action, idempotency_key,
            expected_batch_revision, expected_amendment_sha256, resulting_status,
            decision_id, response_json, created_at
          )
          SELECT
            id, user_id, batch_id, amendment_id, action, idempotency_key,
            expected_batch_revision, expected_amendment_sha256, resulting_status,
            decision_id, response_json, created_at
          FROM daily_operation_amendment_actions;
          DROP TABLE daily_operation_amendment_actions;
        `);
      }
      this.#database.exec(`
        CREATE TABLE daily_operation_amendments_v12 (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          business_date TEXT NOT NULL,
          base_plan_id TEXT NOT NULL,
          base_confirmation_id TEXT,
          origin_id TEXT NOT NULL,
          origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control', 'mode_change')),
          severity TEXT CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
          priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'warning', 'critical')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied', 'superseded', 'cancelled')),
          operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
          proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
          decision_id TEXT,
          amendment_sha256 TEXT NOT NULL,
          based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT,
          UNIQUE (user_id, origin_id),
          UNIQUE (user_id, idempotency_key),
          FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
          FOREIGN KEY (base_plan_id) REFERENCES daily_operation_plans(id) ON DELETE CASCADE,
          FOREIGN KEY (base_confirmation_id) REFERENCES daily_operation_confirmations(id) ON DELETE SET NULL,
          FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
        ) STRICT;
        INSERT INTO daily_operation_amendments_v12 (
          id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
          origin_id, origin_kind, severity, priority, status, operations_json,
          proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
          idempotency_key, created_at, decided_at, decided_by
        )
        SELECT
          id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
          origin_id, origin_kind, severity, priority, status, operations_json,
          proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
          idempotency_key, created_at, decided_at, decided_by
        FROM daily_operation_amendments;
        DROP TABLE daily_operation_amendments;
        ALTER TABLE daily_operation_amendments_v12 RENAME TO daily_operation_amendments;
      `);
    }

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS daily_operation_amendment_actions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        amendment_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
        idempotency_key TEXT NOT NULL,
        expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
        expected_amendment_sha256 TEXT NOT NULL,
        resulting_status TEXT NOT NULL,
        decision_id TEXT,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (amendment_id) REFERENCES daily_operation_amendments(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS daily_operation_amendment_actions_amendment_idx
        ON daily_operation_amendment_actions(amendment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS daily_operation_amendments_batch_date_idx
        ON daily_operation_amendments(user_id, batch_id, business_date DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS feeding_decisions_one_active_idx
        ON feeding_decisions(user_id, batch_id, date_local)
        WHERE status = 'active';
    `);

    const backupExists = Boolean(this.#database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendment_actions_v12_backup'
    `).get());
    if (backupExists) {
      this.#database.exec(`
        INSERT INTO daily_operation_amendment_actions (
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        )
        SELECT
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        FROM daily_operation_amendment_actions_v12_backup;
        DROP TABLE daily_operation_amendment_actions_v12_backup;
      `);
    }
    const amendmentCountAfter = Number(
      (this.#database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendments",
      ).get() as Row).count,
    );
    const actionCountAfter = Number(
      (this.#database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendment_actions",
      ).get() as Row).count,
    );
    const amendmentHashAfter = payloadHash(
      "daily_operation_amendments",
      ["id", "origin_kind", "status", "amendment_sha256", "based_on_batch_revision"],
    );
    const actionHashAfter = actionTableExists || backupExists || actionCountAfter > 0
      ? payloadHash(
          "daily_operation_amendment_actions",
          ["id", "amendment_id", "action", "expected_amendment_sha256", "resulting_status"],
        )
      : "";
    if (
      amendmentCountBefore !== amendmentCountAfter ||
      actionCountBefore !== actionCountAfter ||
      amendmentHashBefore !== amendmentHashAfter ||
      actionHashBefore !== actionHashAfter
    ) {
      throw new LocalStoreError(
        "LOCAL_STORE_INVALID_INPUT",
        "migration V12 would lose amendment or action history; transaction rolled back",
      );
    }
  }

  #backfillLegacyFrozenSnapshots(): void {
    const rows = this.#database.prepare(
      "SELECT user_id, id, data_json FROM batches",
    ).all() as Row[];
    const update = this.#database.prepare(
      "UPDATE batches SET data_json = ? WHERE user_id = ? AND id = ?",
    );
    for (const row of rows) {
      const data = jsonObject(row.data_json, "batches.data_json");
      const config = objectValue(data.config);
      const snapshot = config && objectValue(config.sopTemplate);
      let changed = false;
      if (snapshot && !Object.prototype.hasOwnProperty.call(snapshot, "snapshotSha256")) {
        const snapshotSha256 = legacyFrozenSopSnapshotDigest(snapshot);
        if (snapshotSha256) {
          snapshot.snapshotSha256 = snapshotSha256;
          changed = true;
        }
      }
      const devicePlan = config && objectValue(config.devicePlanSnapshot);
      const templates = devicePlan && objectValue(devicePlan.templates);
      const freeFeeding = templates && objectValue(templates.free_feeding);
      if (devicePlan && freeFeeding && !Object.prototype.hasOwnProperty.call(freeFeeding, "slots")) {
        const slots = legacyFreeFeedingSlots(freeFeeding.windows);
        if (slots) {
          freeFeeding.slots = slots;
          const sha256 = legacyDevicePlanDigest(devicePlan);
          if (sha256) {
            devicePlan.sha256 = sha256;
            changed = true;
          } else {
            delete freeFeeding.slots;
          }
        }
      }
      if (!changed) continue;
      update.run(
        serializeObject(data, "batches.data_json"),
        stringValue(row.user_id, "batches.user_id"),
        stringValue(row.id, "batches.id"),
      );
    }
  }

  getBatch(userId: string, batchId: string): LocalBatch | null {
    this.#ensureOpen();
    const row = this.#database.prepare(
      "SELECT * FROM batches WHERE user_id = ? AND id = ?",
    ).get(requiredText(userId, "userId"), requiredText(batchId, "batchId")) as Row | undefined;
    return row ? batchFromRow(row) : null;
  }

  listBatches(userId: string, options: BatchListOptions = {}): LocalBatch[] {
    this.#ensureOpen();
    const limit = Math.min(nonNegativeInteger(options.limit ?? 500, "limit"), 2_000);
    const rows = this.#database.prepare(`
      SELECT * FROM batches
      WHERE user_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(requiredText(userId, "userId"), limit) as Row[];
    return rows.map(batchFromRow);
  }

  listAllBatches(options: BatchListOptions = {}): LocalBatch[] {
    this.#ensureOpen();
    const limit = Math.min(nonNegativeInteger(options.limit ?? 500, "limit"), 2_000);
    const rows = this.#database.prepare(`
      SELECT * FROM batches
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(limit) as Row[];
    return rows.map(batchFromRow);
  }

  listObservations(userId: string, batchId: string): DailyObservation[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM daily_observations
      WHERE user_id = ? AND batch_id = ?
      ORDER BY observed_at ASC, created_at ASC, id ASC
    `).all(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
    ) as Row[];
    return rows.map(observationFromRow);
  }

  getDailyOperationPlan(
    userId: string,
    batchId: string,
    businessDateValue: string,
  ): DailyOperationPlan | null {
    this.#ensureOpen();
    const row = this.#database.prepare(`
      SELECT * FROM daily_operation_plans
      WHERE user_id = ? AND batch_id = ? AND business_date = ?
    `).get(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
      businessDate(businessDateValue, "businessDate"),
    ) as Row | undefined;
    return row ? dailyOperationPlanFromRow(row) : null;
  }

  getDailyOperationConfirmation(
    userId: string,
    batchId: string,
    businessDateValue: string,
  ): DailyOperationConfirmation | null {
    this.#ensureOpen();
    const row = this.#database.prepare(`
      SELECT * FROM daily_operation_confirmations
      WHERE user_id = ? AND batch_id = ? AND business_date = ?
    `).get(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
      businessDate(businessDateValue, "businessDate"),
    ) as Row | undefined;
    return row ? dailyOperationConfirmationFromRow(row) : null;
  }

  ensureDailyOperationPlan(input: EnsureDailyOperationPlanInput): DailyOperationPlan {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const dateLocal = businessDate(input.businessDate, "businessDate");
    const existing = this.getDailyOperationPlan(userId, batchId, dateLocal);
    if (existing) {
      if (existing.status !== "pending") return existing;
      const operations = dailyOperationItems(input.operations);
      const operationsSha256 = sha256(input.operationsSha256, "operationsSha256");
      if (digestDailyOperations(operations) !== operationsSha256) {
        throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "operationsSha256 does not match operations");
      }
      const proposedSettingJson = nullableJsonParam(input.proposedSetting, existing.proposedSetting);
      const feedbackOriginJson = nullableJsonParam(input.feedbackOrigin, existing.feedbackOrigin);
      if (existing.operationsSha256 === operationsSha256 &&
          existing.proposedSetting !== undefined &&
          JSON.stringify(existing.proposedSetting ?? null) === (proposedSettingJson ?? "null") &&
          existing.feedbackOrigin !== undefined &&
          JSON.stringify(existing.feedbackOrigin ?? null) === (feedbackOriginJson ?? "null")) {
        return existing;
      }
      const batch = this.getBatch(userId, batchId);
      if (!batch) this.#batchNotFound();
      if (batch.status !== "active") {
        throw new LocalStoreError("LOCAL_STORE_BATCH_TERMINAL", "daily operation plans require an active batch");
      }
      this.#database.prepare(`
        UPDATE daily_operation_plans SET
          based_on_batch_revision = ?,
          sop_template_id = ?,
          sop_source_sha256 = ?,
          device_plan_version = ?,
          device_plan_sha256 = ?,
          selected_mode = ?,
          effective_mode = ?,
          operations_json = ?,
          operations_sha256 = ?,
          proposed_setting_json = ?,
          feedback_origin_json = ?,
          status = 'pending'
        WHERE id = ? AND status = 'pending'
      `).run(
        nonNegativeInteger(input.basedOnBatchRevision, "basedOnBatchRevision"),
        requiredText(input.sopTemplateId, "sopTemplateId"),
        sha256(input.sopSourceSha256, "sopSourceSha256"),
        requiredText(input.devicePlanVersion, "devicePlanVersion"),
        sha256(input.devicePlanSha256, "devicePlanSha256"),
        dailyOperationMode(input.selectedMode, "selectedMode"),
        dailyOperationMode(input.effectiveMode, "effectiveMode"),
        JSON.stringify(operations),
        operationsSha256,
        proposedSettingJson,
        feedbackOriginJson,
        existing.id,
      );
      const refreshed = this.getDailyOperationPlan(userId, batchId, dateLocal);
      if (!refreshed) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "daily operation plan was not refreshed");
      return refreshed;
    }

    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    if (batch.status !== "active") {
      throw new LocalStoreError("LOCAL_STORE_BATCH_TERMINAL", "daily operation plans require an active batch");
    }
    const operations = dailyOperationItems(input.operations);
    const operationsSha256 = sha256(input.operationsSha256, "operationsSha256");
    if (digestDailyOperations(operations) !== operationsSha256) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "operationsSha256 does not match operations");
    }
    const id = requiredText(input.id ?? randomUUID(), "id");
    const now = new Date().toISOString();
    const runInsert = () => {
      const concurrent = this.#database.prepare(`
        SELECT * FROM daily_operation_plans
        WHERE user_id = ? AND batch_id = ? AND business_date = ?
      `).get(userId, batchId, dateLocal) as Row | undefined;
      if (concurrent) return;
      this.#database.prepare(`
        INSERT INTO daily_operation_plans (
          id, user_id, batch_id, business_date, based_on_batch_revision,
          sop_template_id, sop_source_sha256, device_plan_version, device_plan_sha256,
          selected_mode, effective_mode, operations_json, operations_sha256,
          proposed_setting_json, feedback_origin_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        id,
        userId,
        batchId,
        dateLocal,
        nonNegativeInteger(input.basedOnBatchRevision, "basedOnBatchRevision"),
        requiredText(input.sopTemplateId, "sopTemplateId"),
        sha256(input.sopSourceSha256, "sopSourceSha256"),
        requiredText(input.devicePlanVersion, "devicePlanVersion"),
        sha256(input.devicePlanSha256, "devicePlanSha256"),
        dailyOperationMode(input.selectedMode, "selectedMode"),
        dailyOperationMode(input.effectiveMode, "effectiveMode"),
        JSON.stringify(operations),
        operationsSha256,
        nullableJsonParam(input.proposedSetting, null),
        nullableJsonParam(input.feedbackOrigin, null),
        now,
      );
    };
    if (this.#transactionDepth > 0) runInsert(); else this.#transaction(runInsert);
    const stored = this.getDailyOperationPlan(userId, batchId, dateLocal);
    if (!stored) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "daily operation plan was not stored");
    return stored;
  }

  confirmDailyOperationPlan(input: ConfirmDailyOperationPlanInput): {
    confirmation: DailyOperationConfirmation;
    replayed: boolean;
  } {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const dateLocal = businessDate(input.businessDate, "businessDate");
    const planId = requiredText(input.planId, "planId");
    const operationsSha256 = sha256(input.operationsSha256, "operationsSha256");
    const confirmedBy = requiredText(input.confirmedBy, "confirmedBy");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const note = input.note === undefined ? undefined : requiredText(input.note, "note").slice(0, 500);
    if (confirmedBy !== userId) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "confirmedBy must be the batch owner");
    }
    const plan = this.#database.prepare(`
      SELECT * FROM daily_operation_plans
      WHERE id = ? AND user_id = ? AND batch_id = ? AND business_date = ?
    `).get(planId, userId, batchId, dateLocal) as Row | undefined;
    if (!plan) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "daily operation plan not found");
    const storedPlan = dailyOperationPlanFromRow(plan);
    if (storedPlan.operationsSha256 !== operationsSha256) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "daily operation hash does not match plan");
    }
    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    if (batch.status !== "active") {
      throw new LocalStoreError("LOCAL_STORE_BATCH_TERMINAL", "daily operation confirmations require an active batch");
    }
    const derivedDeviceSetting = storedPlan.proposedSetting &&
        storedPlan.proposedSetting.kind !== "diarrhea"
      ? proposalToDeviceSetting(storedPlan.proposedSetting)
      : null;
    const expectedDecisionId = input.decisionId ?? null;
    const replay = this.#database.prepare(`
      SELECT * FROM daily_operation_confirmations
      WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, idempotencyKey) as Row | undefined;
    if (replay) {
      const confirmation = dailyOperationConfirmationFromRow(replay);
      if (!this.#confirmationReplayMatches(confirmation, {
        batchId,
        dateLocal,
        planId,
        operationsSha256,
        confirmedBy,
        deviceSetting: derivedDeviceSetting,
        decisionId: expectedDecisionId,
      })) this.#idempotencyConflict();
      return { confirmation, replayed: true };
    }
    const alreadyConfirmed = this.#database.prepare(`
      SELECT * FROM daily_operation_confirmations
      WHERE user_id = ? AND batch_id = ? AND business_date = ?
    `).get(userId, batchId, dateLocal) as Row | undefined;
    if (alreadyConfirmed) {
      const confirmation = dailyOperationConfirmationFromRow(alreadyConfirmed);
      if (!this.#confirmationReplayMatches(confirmation, {
        batchId,
        dateLocal,
        planId,
        operationsSha256,
        confirmedBy,
        deviceSetting: derivedDeviceSetting,
        decisionId: expectedDecisionId,
      })) this.#idempotencyConflict();
      return { confirmation, replayed: true };
    }

    const id = requiredText(input.id ?? randomUUID(), "id");
    const now = new Date().toISOString();
    const runEnsure = () => {
      const transactionReplay = this.#database.prepare(`
        SELECT * FROM daily_operation_confirmations
        WHERE user_id = ? AND idempotency_key = ?
      `).get(userId, idempotencyKey) as Row | undefined;
      if (transactionReplay) {
        const confirmation = dailyOperationConfirmationFromRow(transactionReplay);
        if (!this.#confirmationReplayMatches(confirmation, {
          batchId,
          dateLocal,
          planId,
          operationsSha256,
          confirmedBy,
          deviceSetting: derivedDeviceSetting,
          decisionId: expectedDecisionId,
        })) this.#idempotencyConflict();
        return { confirmation, replayed: true };
      }
      const transactionDayConfirmation = this.#database.prepare(`
        SELECT * FROM daily_operation_confirmations
        WHERE user_id = ? AND batch_id = ? AND business_date = ?
      `).get(userId, batchId, dateLocal) as Row | undefined;
      if (transactionDayConfirmation) {
        const confirmation = dailyOperationConfirmationFromRow(transactionDayConfirmation);
        if (!this.#confirmationReplayMatches(confirmation, {
          batchId,
          dateLocal,
          planId,
          operationsSha256,
          confirmedBy,
          deviceSetting: derivedDeviceSetting,
          decisionId: expectedDecisionId,
        })) this.#idempotencyConflict();
        return { confirmation, replayed: true };
      }
      const update = this.#database.prepare(`
        UPDATE daily_operation_plans SET status = 'confirmed'
        WHERE id = ? AND user_id = ? AND batch_id = ? AND business_date = ? AND status = 'pending'
      `).run(planId, userId, batchId, dateLocal);
      if (Number(update.changes) !== 1) {
        throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "daily operation plan is not pending");
      }
      const decisionId = derivedDeviceSetting
        ? this.#insertActiveDecisionLocked({
            userId,
            batchId,
            dateLocal,
            decision: {
              revision: storedPlan.basedOnBatchRevision,
              batchId,
              dateLocal,
              setting: derivedDeviceSetting,
              exceptionActions: [],
              evidence: {
                sopVersion: storedPlan.sopTemplateId,
                modelVersion: "daily-operation-confirmation@1",
                calculationDate: dateLocal,
                reasons: ["操作员确认今日操作后由服务端写入设备设定。"],
                inputs: {
                  planId,
                  operationsSha256,
                  feedbackProposalDigest: storedPlan.proposedSetting?.proposalDigest ?? null,
                  feedbackOriginId: storedPlan.feedbackOrigin?.id ?? null,
                },
                steps: [
                  {
                    name: "confirmation",
                    value: { confirmedBy },
                    explanation: "今日操作确认由已认证操作员完成。",
                  },
                ],
              },
              status: "active",
            },
            now,
          })
        : null;
      this.#database.prepare(`
        INSERT INTO daily_operation_confirmations (
          id, plan_id, user_id, batch_id, business_date, operations_sha256,
          confirmed_by, confirmed_at, idempotency_key, device_setting_json, decision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        planId,
        userId,
        batchId,
        dateLocal,
        operationsSha256,
        confirmedBy,
        now,
        idempotencyKey,
        derivedDeviceSetting ? JSON.stringify(derivedDeviceSetting) : null,
        decisionId,
      );
      this.#database.prepare(`
        INSERT INTO audit_events (
          user_id, id, batch_id, action, details_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'daily_operations.confirmed', ?, ?, ?)
      `).run(
        userId,
        randomUUID(),
        batchId,
        JSON.stringify({
          planId,
          businessDate: dateLocal,
          operationsSha256,
          actorUserId: confirmedBy,
          basedOnBatchRevision: storedPlan.basedOnBatchRevision,
          sopTemplateId: storedPlan.sopTemplateId,
          sopSourceSha256: storedPlan.sopSourceSha256,
          devicePlanVersion: storedPlan.devicePlanVersion,
          devicePlanSha256: storedPlan.devicePlanSha256,
          selectedMode: storedPlan.selectedMode,
          effectiveMode: storedPlan.effectiveMode,
          ...(note ? { note } : {}),
        }),
        `daily-operations-confirm:${idempotencyKey}`,
        now,
      );
      const confirmationRow = this.#database.prepare(
        "SELECT * FROM daily_operation_confirmations WHERE id = ?",
      ).get(id) as Row | undefined;
      if (!confirmationRow) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "daily operation confirmation was not stored");
      return { confirmation: dailyOperationConfirmationFromRow(confirmationRow), replayed: false };
    };
    if (this.#transactionDepth > 0) return runEnsure();
    return this.#transaction(runEnsure);
  }

  getDailyOperationAmendments(
    userId: string,
    batchId: string,
    businessDateValue: string,
  ): DailyOperationAmendment[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM daily_operation_amendments
      WHERE user_id = ? AND batch_id = ? AND business_date = ?
      ORDER BY created_at ASC, id ASC
    `).all(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
      businessDate(businessDateValue, "businessDate"),
    ) as Row[];
    return rows.map(dailyOperationAmendmentFromRow);
  }

  getDailyOperationAmendment(
    userId: string,
    batchId: string,
    amendmentId: string,
  ): DailyOperationAmendment | null {
    this.#ensureOpen();
    const row = this.#database.prepare(`
      SELECT * FROM daily_operation_amendments
      WHERE user_id = ? AND batch_id = ? AND id = ?
    `).get(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
      requiredText(amendmentId, "amendmentId"),
    ) as Row | undefined;
    return row ? dailyOperationAmendmentFromRow(row) : null;
  }

  supersedeDailyOperationAmendments(input: {
    userId: string;
    batchId: string;
    businessDate: string;
    originKind?: "diarrhea" | "creep_control";
    excludeAmendmentId?: string;
    reason?: "explicit_none" | "newer_observation" | "batch_change";
    sourceObservationId?: string;
    replacementAmendmentId?: string | null;
  }): number {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const dateLocal = businessDate(input.businessDate, "businessDate");
    const now = new Date().toISOString();
    const conditions = [
      "user_id = ?",
      "batch_id = ?",
      "business_date = ?",
      "status IN ('pending', 'confirmed')",
    ];
    const params: Array<string | number> = [userId, batchId, dateLocal];
    if (input.originKind) {
      conditions.push("origin_kind = ?");
      params.push(input.originKind);
    }
    if (input.excludeAmendmentId) {
      conditions.push("id <> ?");
      params.push(input.excludeAmendmentId);
    }
    const result = this.#database.prepare(`
      SELECT id FROM daily_operation_amendments
      WHERE ${conditions.join(" AND ")}
    `).all(...params) as Row[];
    if (result.length === 0) return 0;
    const updateResult = this.#database.prepare(`
      UPDATE daily_operation_amendments
      SET status = 'superseded', decided_at = ?, decided_by = NULL
      WHERE ${conditions.join(" AND ")}
    `).run(now, ...params);
    const reason = input.reason ?? "batch_change";
    const insertAudit = this.#database.prepare(`
      INSERT INTO audit_events (
        user_id, id, batch_id, action, details_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, 'daily_operation_amendments.superseded', ?, ?, ?)
    `);
    for (const row of result) {
      const amendmentId = stringValue(row.id, "daily_operation_amendments.id");
      insertAudit.run(
        userId,
        randomUUID(),
        batchId,
        JSON.stringify({
          reason,
          sourceObservationId: input.sourceObservationId ?? null,
          supersededAmendmentId: amendmentId,
          replacementAmendmentId: input.replacementAmendmentId ?? null,
        }),
        `daily-operation-amendment-supersede:${amendmentId}:${input.sourceObservationId ?? now}`,
        now,
      );
    }
    return Number(updateResult.changes);
  }

  ensureDailyOperationAmendment(
    input: EnsureDailyOperationAmendmentInput,
  ): { amendment: DailyOperationAmendment; replayed: boolean } {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const dateLocal = businessDate(input.businessDate, "businessDate");
    const basePlanId = requiredText(input.basePlanId, "basePlanId");
    const baseConfirmationId = input.baseConfirmationId === null
      ? null
      : requiredText(input.baseConfirmationId, "baseConfirmationId");
    const originId = requiredText(input.originId, "originId");
    const originKind = input.originKind;
    const severity = input.severity;
    const priority = input.priority;
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const basedOnBatchRevision = nonNegativeInteger(
      input.basedOnBatchRevision,
      "basedOnBatchRevision",
    );
    if (originKind !== "diarrhea" && originKind !== "creep_control" && originKind !== "mode_change") {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "invalid originKind");
    }
    if (severity !== null && severity !== "mild" && severity !== "moderate" && severity !== "severe") {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "invalid severity");
    }
    if (priority !== "routine" && priority !== "warning" && priority !== "critical") {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "invalid priority");
    }
    const operations = dailyOperationItems(input.operations);
    const proposal = input.proposal ?? null;
    const digest = amendmentSha256(operations, proposal, basedOnBatchRevision);

    const replay = this.#database.prepare(`
      SELECT * FROM daily_operation_amendments
      WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, idempotencyKey) as Row | undefined;
    if (replay) {
      const amendment = dailyOperationAmendmentFromRow(replay);
      if (amendment.originId !== originId || amendment.amendmentSha256 !== digest) {
        this.#idempotencyConflict();
      }
      return { amendment, replayed: true };
    }

    const existing = this.#database.prepare(`
      SELECT * FROM daily_operation_amendments
      WHERE user_id = ? AND origin_id = ?
    `).get(userId, originId) as Row | undefined;
    if (existing) {
      const amendment = dailyOperationAmendmentFromRow(existing);
      if (amendment.batchId !== batchId ||
          amendment.businessDate !== dateLocal ||
          amendment.originKind !== originKind ||
          amendment.amendmentSha256 !== digest ||
          amendment.basedOnBatchRevision !== basedOnBatchRevision ||
          amendment.priority !== priority) {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_ORIGIN_CONFLICT",
          "origin_id is already bound to a different amendment payload",
        );
      }
      return { amendment, replayed: false };
    }

    const id = requiredText(input.id ?? randomUUID(), "id");
    const now = new Date().toISOString();
    const runEnsure = () => {
      const transactionReplay = this.#database.prepare(`
        SELECT * FROM daily_operation_amendments
        WHERE user_id = ? AND idempotency_key = ?
      `).get(userId, idempotencyKey) as Row | undefined;
      if (transactionReplay) {
        const amendment = dailyOperationAmendmentFromRow(transactionReplay);
        if (amendment.originId !== originId || amendment.amendmentSha256 !== digest) {
          this.#idempotencyConflict();
        }
        return { amendment, replayed: true };
      }
      const transactionExisting = this.#database.prepare(`
        SELECT * FROM daily_operation_amendments
        WHERE user_id = ? AND origin_id = ?
      `).get(userId, originId) as Row | undefined;
      if (transactionExisting) {
        const amendment = dailyOperationAmendmentFromRow(transactionExisting);
        if (amendment.batchId !== batchId ||
            amendment.businessDate !== dateLocal ||
            amendment.originKind !== originKind ||
            amendment.amendmentSha256 !== digest ||
            amendment.basedOnBatchRevision !== basedOnBatchRevision ||
            amendment.priority !== priority) {
          throw new LocalStoreError(
            "LOCAL_STORE_AMENDMENT_ORIGIN_CONFLICT",
            "origin_id is already bound to a different amendment payload",
          );
        }
        return { amendment, replayed: false };
      }

      const batch = this.getBatch(userId, batchId);
      if (!batch) this.#batchNotFound();
      if (batch.status !== "active") {
        throw new LocalStoreError("LOCAL_STORE_BATCH_TERMINAL", "amendments require an active batch");
      }
      const plan = this.#database.prepare(`
        SELECT * FROM daily_operation_plans
        WHERE id = ? AND user_id = ? AND batch_id = ? AND business_date = ?
      `).get(basePlanId, userId, batchId, dateLocal) as Row | undefined;
      if (!plan) {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_CONFIRMATION_REQUIRED",
          "amendment requires a daily operation plan",
        );
      }
      if (baseConfirmationId) {
        if (String(plan.status) !== "confirmed") {
          throw new LocalStoreError(
            "LOCAL_STORE_AMENDMENT_CONFIRMATION_REQUIRED",
            "amendment with a base confirmation requires a confirmed daily operation plan",
          );
        }
        const confirmation = this.#database.prepare(`
          SELECT * FROM daily_operation_confirmations
          WHERE id = ? AND user_id = ? AND batch_id = ? AND business_date = ?
        `).get(baseConfirmationId, userId, batchId, dateLocal) as Row | undefined;
        if (!confirmation) {
          throw new LocalStoreError(
            "LOCAL_STORE_AMENDMENT_CONFIRMATION_REQUIRED",
            "base confirmation not found",
          );
        }
      } else if (String(plan.status) !== "pending") {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_CONFIRMATION_REQUIRED",
          "amendment without a base confirmation requires a pending daily operation plan",
        );
      }
      this.#database.prepare(`
        INSERT INTO daily_operation_amendments (
          id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
          origin_id, origin_kind, severity, priority, status, operations_json, proposal_json,
          decision_id, amendment_sha256, based_on_batch_revision, idempotency_key,
          created_at, decided_at, decided_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)
      `).run(
        id,
        userId,
        batchId,
        dateLocal,
        basePlanId,
        baseConfirmationId,
        originId,
        originKind,
        severity,
        priority,
        JSON.stringify(operations),
        proposal ? JSON.stringify(proposal) : null,
        digest,
        basedOnBatchRevision,
        idempotencyKey,
        now,
      );
      this.#database.prepare(`
        INSERT INTO audit_events (
          user_id, id, batch_id, action, details_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'daily_operation_amendments.created', ?, ?, ?)
      `).run(
        userId,
        randomUUID(),
        batchId,
        JSON.stringify({
          amendmentId: id,
          basePlanId,
          baseConfirmationId,
          originId,
          originKind,
          severity,
          priority,
          amendmentSha256: digest,
          basedOnBatchRevision,
        }),
        `daily-operation-amendment-create:${idempotencyKey}`,
        now,
      );
      return {
        amendment: dailyOperationAmendmentFromRow(this.#database.prepare(
          "SELECT * FROM daily_operation_amendments WHERE id = ?",
        ).get(id) as Row),
        replayed: false,
      };
    };
    if (this.#transactionDepth > 0) return runEnsure();
    return this.#transaction(runEnsure);
  }

  decideDailyOperationAmendment(
    input: DecideDailyOperationAmendmentInput,
  ): { amendment: DailyOperationAmendment; replayed: boolean } {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const amendmentId = requiredText(input.amendmentId, "amendmentId");
    const action = input.action;
    const decidedBy = requiredText(input.decidedBy, "decidedBy");
    const expectedRevision = nonNegativeInteger(
      input.expectedRevision,
      "expectedRevision",
    );
    const expectedSha256 = sha256(
      input.expectedAmendmentSha256,
      "expectedAmendmentSha256",
    );
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    if (action !== "confirm" && action !== "reject" && action !== "apply" && action !== "cancel") {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "invalid amendment action");
    }
    const row = this.#database.prepare(`
      SELECT * FROM daily_operation_amendments
      WHERE user_id = ? AND batch_id = ? AND id = ?
    `).get(userId, batchId, amendmentId) as Row | undefined;
    if (!row) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "amendment not found");

    const actionReplay = this.#database.prepare(`
      SELECT * FROM daily_operation_amendment_actions
      WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, idempotencyKey) as Row | undefined;
    if (actionReplay) {
      if (String(actionReplay.amendment_id) !== amendmentId ||
          String(actionReplay.action) !== action ||
          Number(actionReplay.expected_batch_revision) !== expectedRevision ||
          String(actionReplay.expected_amendment_sha256).toUpperCase() !== expectedSha256) {
        this.#idempotencyConflict();
      }
      const response = JSON.parse(
        stringValue(actionReplay.response_json, "daily_operation_amendment_actions.response_json"),
      ) as { amendment: DailyOperationAmendment; decisionId: string | null };
      return { amendment: response.amendment, replayed: true };
    }

    const stored = dailyOperationAmendmentFromRow(row);
    if (action === "apply") {
      if (!stored.proposal) {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_MANUAL_ONLY",
          "manual-only amendment cannot be applied automatically",
        );
      }
      if (stored.status !== "confirmed") {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_NOT_PENDING",
          `amendment status ${stored.status} does not allow ${action}`,
        );
      }
    } else if (action === "cancel") {
      if (stored.status !== "confirmed") {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_NOT_PENDING",
          `amendment status ${stored.status} does not allow cancel`,
        );
      }
    } else if (stored.status !== "pending") {
      throw new LocalStoreError(
        "LOCAL_STORE_AMENDMENT_NOT_PENDING",
        `amendment status ${stored.status} does not allow ${action}`,
      );
    }
    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    if (batch.revision !== expectedRevision) {
      throw new LocalStoreError(
        "LOCAL_STORE_AMENDMENT_STALE",
        `expected revision ${expectedRevision}, current ${batch.revision}`,
      );
    }
    if (stored.amendmentSha256 !== expectedSha256) {
      throw new LocalStoreError(
        "LOCAL_STORE_AMENDMENT_STALE",
        "amendment digest mismatch",
      );
    }
    if (stored.basedOnBatchRevision !== expectedRevision) {
      throw new LocalStoreError(
        "LOCAL_STORE_AMENDMENT_STALE",
        `amendment based on revision ${stored.basedOnBatchRevision}, expected ${expectedRevision}`,
      );
    }
    if (decidedBy !== userId) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "decidedBy must be the batch owner");
    }

    const now = new Date().toISOString();
    return this.#transaction(() => {
      const transactionActionReplay = this.#database.prepare(`
        SELECT * FROM daily_operation_amendment_actions
        WHERE user_id = ? AND idempotency_key = ?
      `).get(userId, idempotencyKey) as Row | undefined;
      if (transactionActionReplay) {
        if (String(transactionActionReplay.amendment_id) !== amendmentId ||
            String(transactionActionReplay.action) !== action ||
            Number(transactionActionReplay.expected_batch_revision) !== expectedRevision ||
            String(transactionActionReplay.expected_amendment_sha256).toUpperCase() !== expectedSha256) {
          this.#idempotencyConflict();
        }
        const response = JSON.parse(
          stringValue(transactionActionReplay.response_json, "daily_operation_amendment_actions.response_json"),
        ) as { amendment: DailyOperationAmendment; decisionId: string | null };
        return { amendment: response.amendment, replayed: true };
      }
      const transactionRow = this.#database.prepare(`
        SELECT * FROM daily_operation_amendments
        WHERE user_id = ? AND batch_id = ? AND id = ?
      `).get(userId, batchId, amendmentId) as Row | undefined;
      if (!transactionRow) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "amendment not found");
      const current = dailyOperationAmendmentFromRow(transactionRow);
      const transactionBatch = this.getBatch(userId, batchId);
      if (!transactionBatch) this.#batchNotFound();
      if (transactionBatch.revision !== expectedRevision) {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_STALE",
          `batch revision changed to ${transactionBatch.revision}, expected ${expectedRevision}`,
        );
      }
      if (current.basedOnBatchRevision !== expectedRevision) {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_STALE",
          "amendment revision changed concurrently",
        );
      }
      if (action === "apply") {
        if (!current.proposal) {
          throw new LocalStoreError(
            "LOCAL_STORE_AMENDMENT_MANUAL_ONLY",
            "manual-only amendment cannot be applied automatically",
          );
        }
        if (current.status !== "confirmed") {
          throw new LocalStoreError(
            "LOCAL_STORE_AMENDMENT_NOT_PENDING",
            "amendment changed concurrently",
          );
        }
      } else if (action === "cancel") {
        if (current.status !== "confirmed") {
          throw new LocalStoreError(
            "LOCAL_STORE_AMENDMENT_NOT_PENDING",
            "amendment changed concurrently",
          );
        }
      } else if (current.status !== "pending") {
        throw new LocalStoreError(
          "LOCAL_STORE_AMENDMENT_NOT_PENDING",
          "amendment changed concurrently",
        );
      }
      if (action === "apply" && current.originKind === "mode_change") {
        if (!current.proposal) {
          throw new LocalStoreError(
            "LOCAL_STORE_AMENDMENT_MANUAL_ONLY",
            "mode change amendment has no proposal",
          );
        }
        const targetMode = current.proposal.mode;
        const batchData = transactionBatch.data as unknown as Record<string, unknown>;
        const cumulativeActual = cumulativeActualFromRecords(
          batchData.records,
          transactionBatch.currentDay,
        );
        if (cumulativeActual === null) {
          throw new LocalStoreError(
            "LOCAL_STORE_MODE_SWITCH_ACTUAL_UNKNOWN",
            "mode switch apply requires explicit cumulative actual powder",
          );
        }
        if (cumulativeActual > 0) {
          throw new LocalStoreError(
            "LOCAL_STORE_MODE_SWITCH_AFTER_EXECUTION_BLOCKED",
            "mode switch apply is blocked after execution",
          );
        }
        const otherOpen = this.#database.prepare(`
          SELECT id FROM daily_operation_amendments
          WHERE user_id = ? AND batch_id = ? AND business_date = ?
            AND status IN ('pending', 'confirmed') AND id != ?
        `).all(userId, batchId, current.businessDate, amendmentId) as Row[];
        if (otherOpen.length > 0) {
          throw new LocalStoreError(
            "LOCAL_STORE_MODE_SWITCH_AMENDMENT_PENDING",
            "another safety amendment is still open",
          );
        }
        const config = (batchData.config ?? {}) as Record<string, unknown>;
        const nextData = {
          ...batchData,
          config: { ...config, selectedMode: targetMode },
        };
        const decisionId = this.#insertActiveDecisionLocked({
          userId,
          batchId,
          dateLocal: current.businessDate,
          decision: {
            revision: expectedRevision + 1,
            batchId,
            dateLocal: current.businessDate,
            setting: proposalToDeviceSetting(current.proposal),
            exceptionActions: [],
            evidence: {
              sopVersion: "mode-change-amendment@1",
              modelVersion: "execution-contract@1",
              calculationDate: current.businessDate,
              reasons: ["操作员确认并应用模式切换修订；selectedMode 与 active decision 在同一事务变化。"],
              inputs: {
                amendmentId,
                originId: current.originId,
                proposalDigest: current.proposal.proposalDigest,
                targetMode,
              },
              steps: [
                {
                  name: "mode_change_apply",
                  value: { decidedBy, amendmentSha256: current.amendmentSha256 },
                  explanation: "apply 前重新校验批次 revision、累计实际量和其它 pending 安全修订。",
                },
              ],
            },
            status: "active",
          },
          now,
        });
        const batchUpdate = this.#database.prepare(`
          UPDATE batches SET revision = ?, data_json = ?, updated_at = ?
          WHERE user_id = ? AND id = ? AND revision = ?
        `).run(
          expectedRevision + 1,
          serializeObject(nextData, "nextData"),
          now,
          userId,
          batchId,
          expectedRevision,
        );
        if (Number(batchUpdate.changes) !== 1) this.#staleRevision(expectedRevision + 1, expectedRevision);
        this.#database.prepare(`
          UPDATE daily_operation_amendments SET
            status = 'applied', decided_at = ?, decided_by = ?, decision_id = ?
          WHERE id = ? AND user_id = ? AND batch_id = ?
        `).run(now, decidedBy, decisionId, amendmentId, userId, batchId);
        this.#database.prepare(`
          INSERT INTO audit_events (
            user_id, id, batch_id, action, details_json, idempotency_key, created_at
          ) VALUES (?, ?, ?, 'daily_operation_amendments.applied', ?, ?, ?)
        `).run(
          userId,
          randomUUID(),
          batchId,
          JSON.stringify({
            amendmentId,
            action,
            decidedBy,
            amendmentSha256: current.amendmentSha256,
            decisionId,
            previousRevision: expectedRevision,
            newRevision: expectedRevision + 1,
            targetMode,
          }),
          `daily-operation-amendment-applied:${idempotencyKey}`,
          now,
        );
        const actionResult = dailyOperationAmendmentFromRow(this.#database.prepare(
          "SELECT * FROM daily_operation_amendments WHERE id = ?",
        ).get(amendmentId) as Row);
        this.#database.prepare(`
          INSERT INTO daily_operation_amendment_actions (
            id, user_id, batch_id, amendment_id, action, idempotency_key,
            expected_batch_revision, expected_amendment_sha256, resulting_status,
            decision_id, response_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          userId,
          batchId,
          amendmentId,
          action,
          idempotencyKey,
          expectedRevision,
          expectedSha256,
          "applied",
          decisionId,
          JSON.stringify({ amendment: actionResult, decisionId }),
          now,
        );
        return {
          amendment: dailyOperationAmendmentFromRow(this.#database.prepare(
            "SELECT * FROM daily_operation_amendments WHERE id = ?",
          ).get(amendmentId) as Row),
          replayed: false,
        };
      }
      const nextStatus = action === "confirm"
        ? "confirmed" as const
        : action === "reject"
          ? "rejected" as const
          : action === "apply"
            ? "applied" as const
            : "cancelled" as const;
      let decisionId: string | null = current.decisionId;
      if (action === "apply" && current.proposal) {
        const plan = this.#database.prepare(`
          SELECT * FROM daily_operation_plans
          WHERE id = ? AND user_id = ? AND batch_id = ? AND business_date = ?
        `).get(current.basePlanId, userId, batchId, current.businessDate) as Row | undefined;
        const planRef = plan ? dailyOperationPlanFromRow(plan) : null;
        decisionId = this.#insertActiveDecisionLocked({
          userId,
          batchId,
          dateLocal: current.businessDate,
          decision: {
            revision: current.basedOnBatchRevision,
            batchId,
            dateLocal: current.businessDate,
            setting: proposalToDeviceSetting(current.proposal),
            exceptionActions: [],
            evidence: {
              sopVersion: planRef?.sopTemplateId ?? "amendment",
              modelVersion: "daily-operation-amendment@1",
              calculationDate: current.businessDate,
              reasons: ["操作员应用确认后异常修订；原已确认计划保持不变。"],
              inputs: {
                amendmentId,
                originId: current.originId,
                proposalDigest: current.proposal.proposalDigest,
                basePlanId: current.basePlanId,
              },
              steps: [
                {
                  name: "amendment_apply",
                  value: { decidedBy, amendmentSha256: current.amendmentSha256 },
                  explanation: "确认后异常修订由已认证操作员应用并写入 active decision。",
                },
              ],
            },
            status: "active",
          },
          now,
        });
      }
      this.#database.prepare(`
        UPDATE daily_operation_amendments SET
          status = ?, decided_at = ?, decided_by = ?, decision_id = ?
        WHERE id = ? AND user_id = ? AND batch_id = ?
      `).run(nextStatus, now, decidedBy, decisionId, amendmentId, userId, batchId);
      const actionName = action === "confirm"
        ? "confirmed"
        : action === "reject"
          ? "rejected"
          : action === "apply"
            ? "applied"
            : "cancelled";
      this.#database.prepare(`
        INSERT INTO audit_events (
          user_id, id, batch_id, action, details_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        randomUUID(),
        batchId,
        `daily_operation_amendments.${actionName}`,
        JSON.stringify({
          amendmentId,
          action,
          decidedBy,
          amendmentSha256: current.amendmentSha256,
          decisionId,
        }),
        `daily-operation-amendment-${actionName}:${idempotencyKey}`,
        now,
      );
      const actionResult = dailyOperationAmendmentFromRow(this.#database.prepare(
        "SELECT * FROM daily_operation_amendments WHERE id = ?",
      ).get(amendmentId) as Row);
      this.#database.prepare(`
        INSERT INTO daily_operation_amendment_actions (
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        userId,
        batchId,
        amendmentId,
        action,
        idempotencyKey,
        expectedRevision,
        expectedSha256,
        nextStatus,
        decisionId,
        JSON.stringify({ amendment: actionResult, decisionId }),
        now,
      );
      const updated = this.#database.prepare(
        "SELECT * FROM daily_operation_amendments WHERE id = ?",
      ).get(amendmentId) as Row;
      return { amendment: dailyOperationAmendmentFromRow(updated), replayed: false };
    });
  }

  createBatch(input: CreateBatchInput): LocalBatch {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const revision = nonNegativeInteger(input.revision ?? 0, "revision");
    const currentDay = nonNegativeInteger(input.currentDay ?? 0, "currentDay");
    const status = requiredText(input.status ?? "active", "status");
    const dataJson = serializeObject(input.data ?? {}, "data");
    const now = new Date().toISOString();

    this.#transaction(() => {
      this.#database.prepare(
        "INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)",
      ).run(userId, now);
      this.#database.prepare(`
        INSERT OR IGNORE INTO batches (
          user_id, id, revision, current_day, status, data_json,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        batchId,
        revision,
        currentDay,
        status,
        dataJson,
        input.idempotencyKey ?? null,
        now,
        now,
      );
    });

    const stored = this.getBatch(userId, batchId);
    if (!stored) {
      throw new LocalStoreError(
        "LOCAL_STORE_IDEMPOTENCY_CONFLICT",
        "batch idempotency key belongs to another batch",
      );
    }
    return stored;
  }

  getUserByEmail(email: string): LocalUser | null {
    this.#ensureOpen();
    const normalized = requiredText(email, "email").toLowerCase();
    const row = this.#database.prepare(
      "SELECT * FROM users WHERE lower(email) = ? LIMIT 1",
    ).get(normalized) as Row | undefined;
    return row ? userFromRow(row) : null;
  }

  getUserById(userId: string): LocalUser | null {
    this.#ensureOpen();
    const row = this.#database.prepare(
      "SELECT * FROM users WHERE id = ? LIMIT 1",
    ).get(requiredText(userId, "userId")) as Row | undefined;
    return row ? userFromRow(row) : null;
  }

  listUsers(): LocalUser[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(
      "SELECT * FROM users ORDER BY lower(COALESCE(email, '')), created_at ASC, id ASC",
    ).all() as Row[];
    return rows.map(userFromRow);
  }

  createUser(input: {
    id?: string;
    email: string;
    passwordHash: string;
    passwordSalt: string;
    role?: LocalUserRole;
  }): LocalUser {
    this.#ensureOpen();
    const email = requiredText(input.email, "email").trim().toLowerCase();
    const passwordHash = requiredText(input.passwordHash, "passwordHash");
    const passwordSalt = requiredText(input.passwordSalt, "passwordSalt");
    const role = input.role ?? "operator";
    if (role !== "admin" && role !== "operator") {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "invalid role");
    }
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT id FROM users WHERE lower(email) = ? LIMIT 1",
      ).get(email) as Row | undefined;
      if (existing) {
        throw new LocalStoreError("LOCAL_STORE_USER_EXISTS", "email already exists");
      }
      this.#database.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, role, disabled, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(id, email, passwordHash, passwordSalt, role, now);
    });
    const result = this.getUserById(id);
    if (!result) throw new LocalStoreError("LOCAL_STORE_USER_NOT_FOUND", "user was not persisted");
    return result;
  }

  ensureUser(input: {
    id?: string;
    email: string;
    passwordHash: string;
    passwordSalt: string;
    role?: LocalUserRole;
  }): LocalUser {
    this.#ensureOpen();
    const email = requiredText(input.email, "email").toLowerCase();
    const passwordHash = requiredText(input.passwordHash, "passwordHash");
    const passwordSalt = requiredText(input.passwordSalt, "passwordSalt");
    const role = input.role ?? "operator";
    if (role !== "admin" && role !== "operator") {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "invalid role");
    }
    const now = new Date().toISOString();
    this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT id FROM users WHERE lower(email) = ? LIMIT 1",
      ).get(email) as Row | undefined;
      if (existing) {
        this.#database.prepare(`
          UPDATE users SET password_hash = ?, password_salt = ?, role = ?, disabled = 0
          WHERE id = ?
        `).run(passwordHash, passwordSalt, role, stringValue(existing.id, "users.id"));
      } else {
        this.#database.prepare(`
          INSERT INTO users (id, email, password_hash, password_salt, role, disabled, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(input.id ?? randomUUID(), email, passwordHash, passwordSalt, role, now);
      }
    });
    const result = this.getUserByEmail(email);
    if (!result) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "user was not persisted");
    return result;
  }

  getUserCredential(email: string): { user: LocalUser; passwordHash: string; passwordSalt: string } | null {
    this.#ensureOpen();
    const row = this.#database.prepare(
      "SELECT * FROM users WHERE lower(email) = ? LIMIT 1",
    ).get(requiredText(email, "email").toLowerCase()) as Row | undefined;
    if (!row) return null;
    const user = userFromRow(row);
    const passwordHash = nullableString(row.password_hash, "users.password_hash");
    const passwordSalt = nullableString(row.password_salt, "users.password_salt");
    if (!passwordHash || !passwordSalt) return null;
    return { user, passwordHash, passwordSalt };
  }

  createAuthSession(input: {
    userId: string;
    id?: string;
    tokenHash: string;
    expiresAt: string;
  }): LocalSession {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    if (!this.getUserById(userId)) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "user not found");
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(
      input.id ?? randomUUID(),
      userId,
      requiredText(input.tokenHash, "tokenHash"),
      requiredText(input.expiresAt, "expiresAt"),
      now,
    );
    const row = this.#database.prepare(
      "SELECT * FROM auth_sessions WHERE token_hash = ? LIMIT 1",
    ).get(input.tokenHash) as Row;
    return authSessionFromRow(row);
  }

  getAuthSession(tokenHash: string): LocalSession | null {
    this.#ensureOpen();
    const row = this.#database.prepare(
      "SELECT * FROM auth_sessions WHERE token_hash = ? LIMIT 1",
    ).get(requiredText(tokenHash, "tokenHash")) as Row | undefined;
    return row ? authSessionFromRow(row) : null;
  }

  revokeAuthSession(tokenHash: string, revokedAt = new Date().toISOString()): void {
    this.#ensureOpen();
    this.#database.prepare(
      "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?",
    ).run(revokedAt, requiredText(tokenHash, "tokenHash"));
  }

  deleteUser(input: {
    userId: string;
    actorUserId: string;
    confirmEmail: string;
  }): void {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const actorUserId = requiredText(input.actorUserId, "actorUserId");
    // Do not trim confirmation text: the API contract requires an exact
    // match against the normalized email stored for the target account.
    const confirmEmail = input.confirmEmail;
    if (typeof confirmEmail !== "string" || !confirmEmail) {
      throw new LocalStoreError("LOCAL_STORE_USER_CONFIRM_MISMATCH", "confirmation email is required");
    }
    this.#transaction(() => {
      const actorRow = this.#database.prepare(
        "SELECT * FROM users WHERE id = ? LIMIT 1",
      ).get(actorUserId) as Row | undefined;
      if (!actorRow) throw new LocalStoreError("LOCAL_STORE_USER_NOT_FOUND", "actor not found");
      const actor = userFromRow(actorRow);
      if (actor.role !== "admin" || actor.disabled) {
        throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "administrator required");
      }

      const targetRow = this.#database.prepare(
        "SELECT * FROM users WHERE id = ? LIMIT 1",
      ).get(userId) as Row | undefined;
      if (!targetRow) throw new LocalStoreError("LOCAL_STORE_USER_NOT_FOUND", "user not found");
      const target = userFromRow(targetRow);
      if (target.id === actor.id) {
        throw new LocalStoreError("LOCAL_STORE_USER_SELF_DELETE", "cannot delete current user");
      }
      if (!target.email || target.email !== confirmEmail) {
        throw new LocalStoreError("LOCAL_STORE_USER_CONFIRM_MISMATCH", "confirmation email does not match");
      }
      if (target.role === "admin" && !target.disabled) {
        const row = this.#database.prepare(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0",
        ).get() as Row;
        const enabledAdmins = Number(row.count ?? 0);
        if (enabledAdmins <= 1) {
          throw new LocalStoreError("LOCAL_STORE_LAST_ADMIN", "cannot delete last enabled administrator");
        }
      }

      // Preserve immutable SOP records by transferring ownership before the
      // target user is physically deleted. Other user-owned rows intentionally
      // cascade through their existing foreign keys.
      this.#database.prepare(
        "UPDATE sop_templates SET created_by = ? WHERE created_by = ?",
      ).run(actor.id, target.id);
      this.#database.prepare(
        "UPDATE sop_edit_tasks SET created_by = ? WHERE created_by = ?",
      ).run(actor.id, target.id);
      // Explicitly remove sessions so deletion invalidates every token even
      // if a future migration changes the users FK action.
      this.#database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(target.id);
      this.#database.prepare("DELETE FROM users WHERE id = ?").run(target.id);
    });
  }

  appendDailyObservation(input: AppendDailyObservationInput): DailyObservation {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const replay = this.#database.prepare(
      "SELECT * FROM daily_observations WHERE user_id = ? AND idempotency_key = ?",
    ).get(userId, idempotencyKey) as Row | undefined;
    if (replay) {
      const result = observationFromRow(replay);
      if (result.batchId !== batchId) this.#idempotencyConflict();
      return result;
    }

    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    const batchRevision = nonNegativeInteger(input.batchRevision, "batchRevision");
    if (batch.revision !== batchRevision) this.#staleRevision(batch.revision, batchRevision);
    const observedAt = normalizedObservedAt(input.observedAt);
    const data = { ...input.data, recordedAt: observedAt };
    const id = requiredText(input.id ?? randomUUID(), "id");
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO daily_observations (
        user_id, id, batch_id, date_local, observed_at, batch_revision,
        data_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      id,
      batchId,
      requiredText(input.dateLocal, "dateLocal"),
      observedAt,
      batchRevision,
      serializeObject(data, "data"),
      idempotencyKey,
      now,
    );
    const row = this.#database.prepare(
      "SELECT * FROM daily_observations WHERE user_id = ? AND id = ?",
    ).get(userId, id) as Row;
    return observationFromRow(row);
  }

  saveDecision(input: SaveDecisionInput): FeedingDecision {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const decision = input.decision;
    const batchId = requiredText(decision.batchId, "decision.batchId");
    if (input.idempotencyKey) {
      const replay = this.#database.prepare(
        "SELECT batch_id, decision_json FROM feeding_decisions WHERE user_id = ? AND idempotency_key = ?",
      ).get(userId, input.idempotencyKey) as Row | undefined;
      if (replay) {
        if (stringValue(replay.batch_id, "feeding_decisions.batch_id") !== batchId) {
          this.#idempotencyConflict();
        }
        return decisionFromRow(replay);
      }
    }

    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    const revision = nonNegativeInteger(decision.revision, "decision.revision");
    if (revision !== batch.revision) this.#staleRevision(batch.revision, revision);
    const natural = this.#database.prepare(`
      SELECT decision_json FROM feeding_decisions
      WHERE user_id = ? AND batch_id = ? AND date_local = ? AND revision = ?
    `).get(userId, batchId, decision.dateLocal, revision) as Row | undefined;
    const decisionJson = serializeDecision(decision);
    if (natural) {
      if (stringValue(natural.decision_json, "feeding_decisions.decision_json") !== decisionJson) {
        throw new LocalStoreError(
          "LOCAL_STORE_DECISION_CONFLICT",
          "a different decision already exists for this batch date and revision",
        );
      }
      return decisionFromRow(natural);
    }

    if (input.sessionId) this.#requireSession(userId, batchId, input.sessionId);
    const now = new Date().toISOString();
    this.#transaction(() => {
      this.#insertActiveDecisionLocked({
        userId,
        batchId,
        dateLocal: decision.dateLocal,
        decision,
        now,
      });
    });
    return decision;
  }

  getActiveDecision(
    userId: string,
    batchId: string,
    dateLocal?: string,
  ): FeedingDecision | null {
    this.#ensureOpen();
    const params: string[] = [
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
    ];
    let sql = `
      SELECT decision_json FROM feeding_decisions
      WHERE user_id = ? AND batch_id = ? AND status = 'active'
    `;
    if (dateLocal !== undefined) {
      sql += " AND date_local = ?";
      params.push(requiredText(dateLocal, "dateLocal"));
    }
    sql += " ORDER BY date_local DESC, revision DESC, created_at DESC LIMIT 1";
    const row = this.#database.prepare(sql).get(...params) as Row | undefined;
    return row ? decisionFromRow(row) : null;
  }

  getActiveDecisionRecord(
    userId: string,
    batchId: string,
    dateLocal?: string,
  ): { id: string; decision: FeedingDecision } | null {
    this.#ensureOpen();
    const params: string[] = [
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
    ];
    let sql = `
      SELECT id, decision_json FROM feeding_decisions
      WHERE user_id = ? AND batch_id = ? AND status = 'active'
    `;
    if (dateLocal !== undefined) {
      sql += " AND date_local = ?";
      params.push(requiredText(dateLocal, "dateLocal"));
    }
    sql += " ORDER BY date_local DESC, revision DESC, created_at DESC LIMIT 1";
    const row = this.#database.prepare(sql).get(...params) as Row | undefined;
    if (!row) return null;
    return {
      id: stringValue(row.id, "feeding_decisions.id"),
      decision: decisionFromRow(row),
    };
  }

  listSopTemplates(): LocalSopTemplate[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(
      "SELECT * FROM sop_templates ORDER BY created_at DESC, id DESC",
    ).all() as Row[];
    return rows.map(sopTemplateFromRow);
  }

  getPublishedSopTemplate(): LocalSopTemplate | null {
    this.#ensureOpen();
    const row = this.#database.prepare(`
      SELECT t.* FROM sop_publication_state s
      JOIN sop_templates t ON t.id = s.active_template_id
      WHERE s.singleton = 1 AND t.status = 'published'
    `).get() as Row | undefined;
    return row ? sopTemplateFromRow(row) : null;
  }

  getSopTemplate(templateId: string): LocalSopTemplate | null {
    this.#ensureOpen();
    const row = this.#database.prepare(
      "SELECT * FROM sop_templates WHERE id = ?",
    ).get(requiredText(templateId, "templateId")) as Row | undefined;
    return row ? sopTemplateFromRow(row) : null;
  }

  createSopTemplate(input: {
    id?: string;
    version: string;
    name: string;
    config: Record<string, unknown>;
    createdBy: string;
    sourceTemplateId?: string | null;
    sourceMarkdown?: string;
    sourceSha256?: string;
    collectionRevision?: string;
    parserVersion?: string;
    embeddingModel?: string;
  }): LocalSopTemplate {
    this.#ensureOpen();
    const version = requiredText(input.version, "version");
    const name = requiredText(input.name, "name");
    const createdBy = requiredText(input.createdBy, "createdBy");
    if (!this.getUserById(createdBy)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "creator not found");
    }
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO sop_templates (
        id, version, name, config_json, created_by, source_template_id, created_at,
        status, source_markdown, source_sha256, collection_revision,
        parser_version, embedding_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
    `).run(
      id,
      version,
      name,
      serializeObject(input.config, "config"),
      createdBy,
      input.sourceTemplateId ?? null,
      now,
      input.sourceMarkdown ?? "",
      input.sourceSha256 ?? "",
      input.collectionRevision ?? "",
      input.parserVersion ?? "",
      input.embeddingModel ?? "",
    );
    const row = this.#database.prepare(
      "SELECT * FROM sop_templates WHERE id = ?",
    ).get(id) as Row;
    return sopTemplateFromRow(row);
  }

  publishSopTemplate(input: { templateId: string; chunks: SopKnowledgeChunk[] }): LocalSopTemplate {
    this.#ensureOpen();
    const templateId = requiredText(input.templateId, "templateId");
    const template = this.getSopTemplate(templateId);
    if (!template) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP template not found");
    if (template.status === "published") return template;
    if (!template.sourceSha256 || !template.collectionRevision || !template.parserVersion || !template.embeddingModel) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP knowledge metadata incomplete");
    }
    if (input.chunks.length === 0) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP chunks are required");
    }
    const now = new Date().toISOString();
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM sop_knowledge_chunks WHERE template_id = ?").run(templateId);
      const insert = this.#database.prepare(`
        INSERT INTO sop_knowledge_chunks (
          template_id, chunk_id, section_id, chunk_index, title, text,
          source_sha256, collection_revision, lexical_terms_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of input.chunks) {
        if (chunk.templateId !== templateId || chunk.sourceSha256 !== template.sourceSha256 ||
            chunk.collectionRevision !== template.collectionRevision) {
          throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP chunk metadata mismatch");
        }
        insert.run(
          templateId, requiredText(chunk.chunkId, "chunkId"), requiredText(chunk.sectionId, "sectionId"),
          nonNegativeInteger(chunk.chunkIndex, "chunkIndex"), requiredText(chunk.title, "title"),
          requiredText(chunk.text, "text"), chunk.sourceSha256, chunk.collectionRevision,
          JSON.stringify(chunk.lexicalTerms),
        );
      }
      this.#database.prepare(`
        UPDATE sop_templates SET status = 'published', chunk_count = ?, published_at = ?, index_error = NULL
        WHERE id = ? AND status IN ('draft', 'failed')
      `).run(input.chunks.length, now, templateId);
      this.#database.prepare(`
        INSERT INTO sop_publication_state (singleton, active_template_id, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET active_template_id = excluded.active_template_id,
          updated_at = excluded.updated_at
      `).run(templateId, now);
    });
    return this.getSopTemplate(templateId)!;
  }

  failSopTemplate(templateId: string, error: string): LocalSopTemplate {
    this.#ensureOpen();
    const id = requiredText(templateId, "templateId");
    this.#database.prepare(`
      UPDATE sop_templates SET status = 'failed', index_error = ?
      WHERE id = ? AND status <> 'published'
    `).run(requiredText(error, "error").slice(0, 2_000), id);
    const result = this.getSopTemplate(id);
    if (!result) throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP template not found");
    return result;
  }

  listSopKnowledgeChunks(templateId: string): SopKnowledgeChunk[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM sop_knowledge_chunks WHERE template_id = ?
      ORDER BY section_id ASC, chunk_index ASC
    `).all(requiredText(templateId, "templateId")) as Row[];
    return rows.map(sopChunkFromRow);
  }

  createSopEditTask(input: {
    id?: string;
    templateId: string | null;
    instruction: string;
    createdBy: string;
  }): SopEditTask {
    this.#ensureOpen();
    const instruction = requiredText(input.instruction, "instruction");
    const createdBy = requiredText(input.createdBy, "createdBy");
    if (!this.getUserById(createdBy)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "creator not found");
    }
    const templateId = input.templateId === null
      ? null
      : requiredText(input.templateId ?? "", "templateId");
    if (templateId && !this.getSopTemplate(templateId)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP template not found");
    }
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO sop_edit_tasks (id, template_id, instruction, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'drafting', ?, ?, ?)
    `).run(id, templateId, instruction, createdBy, now, now);
    const row = this.#database.prepare(
      "SELECT * FROM sop_edit_tasks WHERE id = ?",
    ).get(id) as Row;
    return sopEditTaskFromRow(row);
  }

  getSopEditTask(taskId: string): SopEditTask | null {
    this.#ensureOpen();
    const row = this.#database.prepare(
      "SELECT * FROM sop_edit_tasks WHERE id = ?",
    ).get(requiredText(taskId, "taskId")) as Row | undefined;
    return row ? sopEditTaskFromRow(row) : null;
  }

  listSopEditTasks(limit = 100): SopEditTask[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM sop_edit_tasks
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.min(nonNegativeInteger(limit, "limit"), 500)) as Row[];
    return rows.map(sopEditTaskFromRow);
  }

  completeSopEditTaskDraft(input: {
    taskId: string;
    proposedMarkdown: string;
    proposedConfig: Record<string, unknown>;
    changeSummary: string;
    affectedSections: string[];
  }): SopEditTask {
    this.#ensureOpen();
    const taskId = requiredText(input.taskId, "taskId");
    const proposedMarkdown = requiredText(input.proposedMarkdown, "proposedMarkdown");
    const changeSummary = requiredText(input.changeSummary, "changeSummary");
    if (!Array.isArray(input.affectedSections) ||
        input.affectedSections.some((section) => typeof section !== "string")) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "affectedSections must be strings");
    }
    const now = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE sop_edit_tasks SET
        status = 'draft_ready',
        proposed_markdown = ?,
        proposed_config_json = ?,
        change_summary = ?,
        affected_sections_json = ?,
        error_code = NULL,
        updated_at = ?
      WHERE id = ? AND status = 'drafting'
    `).run(
      proposedMarkdown,
      serializeObject(input.proposedConfig, "proposedConfig"),
      changeSummary,
      JSON.stringify(input.affectedSections),
      now,
      taskId,
    );
    if (result.changes === 0) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP edit task is not drafting");
    }
    return this.getSopEditTask(taskId)!;
  }

  failSopEditTaskDraft(input: { taskId: string; errorCode: string }): SopEditTask {
    this.#ensureOpen();
    const taskId = requiredText(input.taskId, "taskId");
    const errorCode = requiredText(input.errorCode, "errorCode").slice(0, 200);
    const now = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE sop_edit_tasks SET status = 'draft_failed', error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'drafting'
    `).run(errorCode, now, taskId);
    if (result.changes === 0) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP edit task is not drafting");
    }
    return this.getSopEditTask(taskId)!;
  }

  publishSopEditTask(input: {
    taskId: string;
    publishedTemplateId: string;
    confirmedBy: string;
  }): SopEditTask {
    this.#ensureOpen();
    const taskId = requiredText(input.taskId, "taskId");
    const publishedTemplateId = requiredText(input.publishedTemplateId, "publishedTemplateId");
    const confirmedBy = requiredText(input.confirmedBy, "confirmedBy");
    if (!this.getUserById(confirmedBy)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "confirmer not found");
    }
    if (!this.getSopTemplate(publishedTemplateId)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "published SOP template not found");
    }
    const now = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE sop_edit_tasks SET
        status = 'published',
        published_template_id = ?,
        confirmed_by = ?,
        confirmed_at = ?,
        updated_at = ?
      WHERE id = ? AND status = 'draft_ready'
    `).run(publishedTemplateId, confirmedBy, now, now, taskId);
    if (result.changes === 0) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP edit task is not draft_ready");
    }
    return this.getSopEditTask(taskId)!;
  }

  rejectSopEditTask(input: { taskId: string; rejectedBy: string }): SopEditTask {
    this.#ensureOpen();
    const taskId = requiredText(input.taskId, "taskId");
    const rejectedBy = requiredText(input.rejectedBy, "rejectedBy");
    if (!this.getUserById(rejectedBy)) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "rejecting user not found");
    }
    const now = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE sop_edit_tasks SET
        status = 'rejected',
        confirmed_by = ?,
        confirmed_at = ?,
        updated_at = ?
      WHERE id = ? AND status IN ('drafting', 'draft_ready', 'draft_failed')
    `).run(rejectedBy, now, now, taskId);
    if (result.changes === 0) {
      throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP edit task is already terminal");
    }
    return this.getSopEditTask(taskId)!;
  }

  #persistObservationIdInNextData(
    nextData: Record<string, unknown>,
    observation: Record<string, unknown>,
    observationId: string,
  ): Record<string, unknown> {
    const result = structuredClone(nextData);
    const records = Array.isArray(result.records)
      ? result.records as Array<Record<string, unknown>>
      : [];
    result.records = records.map((row) =>
      Number(row.dayIndex) === Number(observation.dayIndex)
        ? {
            ...row,
            recordedAt: observation.recordedAt ?? row.recordedAt,
            observationId,
          }
        : row,
    );
    return result;
  }

  #materializeFeedbackLocked(input: {
    userId: string;
    batchId: string;
    expectedRevision: number;
    observationId: string;
    observation: Record<string, unknown>;
    nextData: Record<string, unknown>;
    feedbackBatch: LocalBatch;
    result: Record<string, unknown>;
  }): Record<string, unknown> {
    const nextData = this.#persistObservationIdInNextData(
      input.nextData,
      input.observation,
      input.observationId,
    );
    const batch = {
      ...input.feedbackBatch,
      revision: input.expectedRevision + 1,
      data: nextData,
    } as LocalBatch;
    const materialized = materializeObservationFeedbackPlan({
      store: this as unknown as LocalStore,
      userId: input.userId,
      batch,
      observation: { ...input.observation, observationId: input.observationId },
    });
    const amendments = this.getDailyOperationAmendments(
      input.userId,
      input.batchId,
      materialized.plan.businessDate,
    );
    return {
      ...input.result,
      feedback: materialized.feedback,
      amendments,
    };
  }

  commitAdvance(input: CommitAdvanceInput): CommitResult {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const key = requiredText(input.idempotencyKey, "idempotencyKey");
    const replay = this.#database.prepare(`
      SELECT response_json FROM operation_results
      WHERE user_id = ? AND batch_id = ? AND operation = 'advance' AND idempotency_key = ?
    `).get(userId, batchId, key) as Row | undefined;
    if (replay) return resultFromJson(stringValue(replay.response_json, "operation_results.response_json"));
    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    const expected = nonNegativeInteger(input.expectedRevision, "expectedRevision");
    if (batch.revision !== expected) this.#staleRevision(batch.revision, expected);
    const now = new Date().toISOString();
    const observedAt = normalizedObservedAt(input.observedAt);
    const observation = {
      ...input.observation,
      recordedAt: observedAt,
      dayIndex: Number(input.observation.dayIndex ?? batch.currentDay),
      revision: expected,
    };
    let resultPayload: Record<string, unknown> = input.result;
    this.#transaction(() => {
      const inserted = this.#insertObservation({
        userId,
        batchId,
        dateLocal: requiredText(input.dateLocal, "dateLocal"),
        observedAt,
        batchRevision: expected,
        data: observation,
        idempotencyKey: key,
      });
      const persistedNextData = input.feedbackBatch
        ? this.#persistObservationIdInNextData(input.nextData, observation, inserted.id)
        : input.nextData;
      const update = this.#database.prepare(`
        UPDATE batches
        SET revision = ?, current_day = ?, data_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND revision = ?
      `).run(
        expected + 1,
        nonNegativeInteger(input.nextDayIndex, "nextDayIndex"),
        serializeObject(persistedNextData, "nextData"),
        now,
        userId,
        batchId,
        expected,
      );
      if (Number(update.changes) !== 1) this.#staleRevision(expected + 1, expected);
      resultPayload = input.feedbackBatch
        ? this.#materializeFeedbackLocked({
            userId,
            batchId,
            expectedRevision: expected,
            observationId: inserted.id,
            observation,
            nextData: persistedNextData,
            feedbackBatch: input.feedbackBatch,
            result: input.result,
          })
        : input.result;
      this.#database.prepare(`
        INSERT INTO operation_results (
          user_id, batch_id, operation, idempotency_key, response_json, created_at
        ) VALUES (?, ?, 'advance', ?, ?, ?)
      `).run(userId, batchId, key, serializeObject(resultPayload, "result"), now);
    });
    return { replayed: false, result: resultPayload };
  }

  commitRecord(input: CommitRecordInput): CommitResult {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const key = requiredText(input.idempotencyKey, "idempotencyKey");
    const replay = this.#database.prepare(`
      SELECT response_json FROM operation_results
      WHERE user_id = ? AND batch_id = ? AND operation = 'record' AND idempotency_key = ?
    `).get(userId, batchId, key) as Row | undefined;
    if (replay) return resultFromJson(stringValue(replay.response_json, "operation_results.response_json"));
    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    const expected = nonNegativeInteger(input.expectedRevision, "expectedRevision");
    if (batch.revision !== expected) this.#staleRevision(batch.revision, expected);
    const now = new Date().toISOString();
    const observedAt = normalizedObservedAt(input.observedAt);
    const observation = {
      ...input.observation,
      recordedAt: observedAt,
      revision: expected,
    };
    let resultPayload: Record<string, unknown> = input.result;
    this.#transaction(() => {
      const inserted = this.#insertObservation({
        userId,
        batchId,
        dateLocal: requiredText(input.dateLocal, "dateLocal"),
        observedAt,
        batchRevision: expected,
        data: observation,
        idempotencyKey: key,
      });
      const persistedNextData = input.feedbackBatch
        ? this.#persistObservationIdInNextData(
            input.nextData,
            observation,
            inserted.id,
          )
        : input.nextData;
      const update = this.#database.prepare(`
        UPDATE batches SET revision = ?, data_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND revision = ?
      `).run(
        expected + 1,
        serializeObject(persistedNextData, "nextData"),
        now,
        userId,
        batchId,
        expected,
      );
      if (Number(update.changes) !== 1) this.#staleRevision(expected + 1, expected);
      resultPayload = input.feedbackBatch
        ? this.#materializeFeedbackLocked({
            userId,
            batchId,
            expectedRevision: expected,
            observationId: inserted.id,
            observation,
            nextData: persistedNextData,
            feedbackBatch: input.feedbackBatch,
            result: input.result,
          })
        : input.result;
      this.#database.prepare(`
        INSERT INTO operation_results (
          user_id, batch_id, operation, idempotency_key, response_json, created_at
        ) VALUES (?, ?, 'record', ?, ?, ?)
      `).run(userId, batchId, key, serializeObject(resultPayload, "result"), now);
    });
    return { replayed: false, result: resultPayload };
  }

  commitModeSwitch(input: CommitModeSwitchInput): CommitResult {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const key = requiredText(input.idempotencyKey, "idempotencyKey");
    const replay = this.#database.prepare(`
      SELECT * FROM audit_events WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, key) as Row | undefined;
    if (replay) {
      const event = auditFromRow(replay);
      const details = event.details;
      if (
        event.batchId !== batchId ||
        event.action !== "batch.mode_switched" ||
        details.toMode !== input.toMode ||
        details.previousRevision !== input.expectedRevision
      ) {
        this.#idempotencyConflict();
      }
      const response = details.response;
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "mode switch replay is invalid");
      }
      return { replayed: true, result: response as Record<string, unknown> };
    }

    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    const expected = nonNegativeInteger(input.expectedRevision, "expectedRevision");
    if (batch.revision !== expected) this.#staleRevision(batch.revision, expected);
    const now = new Date().toISOString();
    const resultJson = serializeObject(input.result, "result");
    const planInput = input.planInput;
    const details = {
      fromMode: input.fromMode,
      toMode: input.toMode,
      previousRevision: expected,
      newRevision: expected + 1,
      devicePlanVersion: requiredText(input.devicePlanVersion, "devicePlanVersion"),
      devicePlanSha256: requiredText(input.devicePlanSha256, "devicePlanSha256"),
      response: JSON.parse(resultJson) as Record<string, unknown>,
    };

    this.#transaction(() => {
      const update = this.#database.prepare(`
        UPDATE batches SET revision = ?, data_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND revision = ?
      `).run(
        expected + 1,
        serializeObject(input.nextData, "nextData"),
        now,
        userId,
        batchId,
        expected,
      );
      if (Number(update.changes) !== 1) this.#staleRevision(expected + 1, expected);
      if (planInput) {
        const existingPlan = this.getDailyOperationPlan(
          userId,
          batchId,
          businessDate(planInput.businessDate, "planInput.businessDate"),
        );
        if (!existingPlan || existingPlan.status === "pending") {
          this.ensureDailyOperationPlan(planInput);
        }
      }
      this.#database.prepare(`
        INSERT INTO audit_events (
          user_id, id, batch_id, action, details_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'batch.mode_switched', ?, ?, ?)
      `).run(userId, randomUUID(), batchId, serializeObject(details, "details"), key, now);
    });
    return { replayed: false, result: input.result };
  }

  commitSopMigration(input: CommitSopMigrationInput): CommitResult {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const key = requiredText(input.idempotencyKey, "idempotencyKey");
    const targetTemplateId = requiredText(input.targetTemplateId, "targetTemplateId");
    const actorUserId = requiredText(input.actorUserId, "actorUserId");
    const expected = nonNegativeInteger(input.expectedRevision, "expectedRevision");
    const replay = this.#database.prepare(`
      SELECT * FROM audit_events WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, key) as Row | undefined;
    if (replay) {
      const event = auditFromRow(replay);
      const details = event.details;
      if (
        event.batchId !== batchId ||
        event.action !== "batch.sop_migrated" ||
        details.targetTemplateId !== targetTemplateId ||
        details.previousRevision !== expected ||
        details.actorUserId !== actorUserId
      ) this.#idempotencyConflict();
      const response = details.response;
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "SOP migration replay is invalid");
      }
      return { replayed: true, result: response as Record<string, unknown> };
    }

    const batch = this.getBatch(userId, batchId);
    if (!batch) this.#batchNotFound();
    if (batch.status !== "active") {
      throw new LocalStoreError("LOCAL_STORE_BATCH_TERMINAL", "SOP migration requires an active batch");
    }
    if (batch.revision !== expected) this.#staleRevision(batch.revision, expected);

    const replacement = input.replacementDailyOperationPlan;
    if (replacement) {
      if (replacement.userId !== userId || replacement.batchId !== batchId) {
        throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "replacement daily operation plan belongs to another batch");
      }
      nonNegativeInteger(replacement.basedOnBatchRevision, "replacement.basedOnBatchRevision");
      requiredText(replacement.sopTemplateId, "replacement.sopTemplateId");
      sha256(replacement.sopSourceSha256, "replacement.sopSourceSha256");
      requiredText(replacement.devicePlanVersion, "replacement.devicePlanVersion");
      sha256(replacement.devicePlanSha256, "replacement.devicePlanSha256");
      dailyOperationMode(replacement.selectedMode, "replacement.selectedMode");
      dailyOperationMode(replacement.effectiveMode, "replacement.effectiveMode");
      const replacementOperations = dailyOperationItems(replacement.operations);
      const replacementHash = sha256(replacement.operationsSha256, "replacement.operationsSha256");
      if (digestDailyOperations(replacementOperations) !== replacementHash) {
        throw new LocalStoreError("LOCAL_STORE_INVALID_INPUT", "replacement operations hash does not match operations");
      }
    }

    const now = new Date().toISOString();
    const resultJson = serializeObject(input.result, "result");
    const details = {
      ...input.auditDetails,
      actorUserId,
      targetTemplateId,
      previousRevision: expected,
      newRevision: expected + 1,
      response: JSON.parse(resultJson) as Record<string, unknown>,
    };

    this.#transaction(() => {
      const update = this.#database.prepare(`
        UPDATE batches SET revision = ?, data_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND revision = ?
      `).run(
        expected + 1,
        serializeObject(input.nextData, "nextData"),
        now,
        userId,
        batchId,
        expected,
      );
      if (Number(update.changes) !== 1) this.#staleRevision(expected + 1, expected);

      if (replacement) {
        const existingRow = this.#database.prepare(`
          SELECT * FROM daily_operation_plans
          WHERE user_id = ? AND batch_id = ? AND business_date = ?
        `).get(userId, batchId, businessDate(replacement.businessDate, "replacement.businessDate")) as Row | undefined;
        if (existingRow) {
          const existing = dailyOperationPlanFromRow(existingRow);
          if (existing.status !== "pending") {
            throw new LocalStoreError(
              "LOCAL_STORE_DAILY_OPERATION_CONFIRMED",
              "confirmed daily operation plans cannot be rewritten",
            );
          }
          const replacementOperations = dailyOperationItems(replacement.operations);
          const replacementHash = sha256(replacement.operationsSha256, "replacement.operationsSha256");
          const refreshed = this.#database.prepare(`
            UPDATE daily_operation_plans
            SET based_on_batch_revision = ?, sop_template_id = ?, sop_source_sha256 = ?,
                device_plan_version = ?, device_plan_sha256 = ?, selected_mode = ?, effective_mode = ?,
                operations_json = ?, operations_sha256 = ?
            WHERE id = ? AND user_id = ? AND batch_id = ? AND business_date = ? AND status = 'pending'
          `).run(
            nonNegativeInteger(replacement.basedOnBatchRevision, "replacement.basedOnBatchRevision"),
            requiredText(replacement.sopTemplateId, "replacement.sopTemplateId"),
            sha256(replacement.sopSourceSha256, "replacement.sopSourceSha256"),
            requiredText(replacement.devicePlanVersion, "replacement.devicePlanVersion"),
            sha256(replacement.devicePlanSha256, "replacement.devicePlanSha256"),
            dailyOperationMode(replacement.selectedMode, "replacement.selectedMode"),
            dailyOperationMode(replacement.effectiveMode, "replacement.effectiveMode"),
            JSON.stringify(replacementOperations),
            replacementHash,
            existing.id,
            userId,
            batchId,
            businessDate(replacement.businessDate, "replacement.businessDate"),
          );
          if (Number(refreshed.changes) !== 1) {
            throw new LocalStoreError("LOCAL_STORE_DAILY_OPERATION_CONFIRMED", "daily operation plan changed during migration");
          }
        }
      }

      this.#database.prepare(`
        INSERT INTO audit_events (
          user_id, id, batch_id, action, details_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'batch.sop_migrated', ?, ?, ?)
      `).run(userId, randomUUID(), batchId, serializeObject(details, "details"), key, now);
    });
    return { replayed: false, result: input.result };
  }

  createSession(input: CreateSessionInput): AgentSession {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const id = requiredText(input.id, "id");
    if (!this.getBatch(userId, batchId)) this.#batchNotFound();
    const replay = this.#database.prepare(
      "SELECT * FROM agent_sessions WHERE user_id = ? AND id = ?",
    ).get(userId, id) as Row | undefined;
    if (replay) {
      const result = sessionFromRow(replay);
      if (result.batchId !== batchId) this.#idempotencyConflict();
      return result;
    }
    if (input.idempotencyKey) {
      const byKey = this.#database.prepare(
        "SELECT * FROM agent_sessions WHERE user_id = ? AND idempotency_key = ?",
      ).get(userId, input.idempotencyKey) as Row | undefined;
      if (byKey) {
        const result = sessionFromRow(byKey);
        if (result.batchId !== batchId) this.#idempotencyConflict();
        return result;
      }
    }
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO agent_sessions (
        user_id, id, batch_id, status, provider, model,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      id,
      batchId,
      input.status ?? "active",
      input.provider ?? null,
      input.model ?? null,
      input.idempotencyKey ?? null,
      now,
      now,
    );
    const row = this.#database.prepare(
      "SELECT * FROM agent_sessions WHERE user_id = ? AND id = ?",
    ).get(userId, id) as Row;
    return sessionFromRow(row);
  }

  getSession(
    userId: string,
    batchId: string,
    sessionId: string,
  ): AgentSession | null {
    this.#ensureOpen();
    const row = this.#database.prepare(`
      SELECT * FROM agent_sessions
      WHERE user_id = ? AND batch_id = ? AND id = ?
      LIMIT 1
    `).get(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
      requiredText(sessionId, "sessionId"),
    ) as Row | undefined;
    return row ? sessionFromRow(row) : null;
  }

  listSessions(userId: string, batchId: string): AgentSession[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM agent_sessions
      WHERE user_id = ? AND batch_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
    ) as Row[];
    return rows.map(sessionFromRow);
  }

  appendMessage(input: AppendMessageInput): AgentMessage {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = requiredText(input.batchId, "batchId");
    const sessionId = requiredText(input.sessionId, "sessionId");
    this.#requireSession(userId, batchId, sessionId);
    if (input.idempotencyKey) {
      const replay = this.#database.prepare(
        "SELECT * FROM agent_messages WHERE user_id = ? AND idempotency_key = ?",
      ).get(userId, input.idempotencyKey) as Row | undefined;
      if (replay) {
        const result = messageFromRow(replay);
        if (result.batchId !== batchId || result.sessionId !== sessionId) {
          this.#idempotencyConflict();
        }
        return result;
      }
    }
    const id = requiredText(input.id ?? randomUUID(), "id");
    const now = this.#monotonicNow();
    this.#database.prepare(`
      INSERT INTO agent_messages (
        user_id, id, batch_id, session_id, role, content, tool_name,
        tool_call_id, evidence_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      id,
      batchId,
      sessionId,
      input.role,
      input.content,
      input.toolName ?? null,
      input.toolCallId ?? null,
      serializeObject(input.evidence ?? {}, "evidence"),
      input.idempotencyKey ?? null,
      now,
    );
    const row = this.#database.prepare(
      "SELECT * FROM agent_messages WHERE user_id = ? AND id = ?",
    ).get(userId, id) as Row;
    return messageFromRow(row);
  }

  listMessages(
    userId: string,
    batchId: string,
    sessionId: string,
    options: ListMessagesOptions = {},
  ): AgentMessage[] {
    this.#ensureOpen();
    const normalizedUserId = requiredText(userId, "userId");
    const normalizedBatchId = requiredText(batchId, "batchId");
    const normalizedSessionId = requiredText(sessionId, "sessionId");
    if (!this.#sessionExists(normalizedUserId, normalizedBatchId, normalizedSessionId)) return [];
    const requestedLimit = options.limit ?? 100;
    const limit = Math.min(nonNegativeInteger(requestedLimit, "limit"), 1_000);
    const rows = this.#database.prepare(`
      SELECT * FROM (
        SELECT * FROM agent_messages
        WHERE user_id = ? AND batch_id = ? AND session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY created_at ASC, id ASC
    `).all(normalizedUserId, normalizedBatchId, normalizedSessionId, limit) as Row[];
    return rows.map(messageFromRow);
  }

  findMessagesByClientMessageId(
    userId: string,
    batchId: string,
    sessionId: string,
    clientMessageId: string,
  ): AgentMessage[] {
    this.#ensureOpen();
    const normalizedUserId = requiredText(userId, "userId");
    const normalizedBatchId = requiredText(batchId, "batchId");
    const normalizedSessionId = requiredText(sessionId, "sessionId");
    const normalizedClientMessageId = requiredText(clientMessageId, "clientMessageId");
    if (!this.#sessionExists(normalizedUserId, normalizedBatchId, normalizedSessionId)) return [];
    const rows = this.#database.prepare(`
      SELECT * FROM agent_messages
      WHERE user_id = ? AND batch_id = ? AND session_id = ?
        AND json_extract(evidence_json, '$.clientMessageId') = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 2
    `).all(
      normalizedUserId,
      normalizedBatchId,
      normalizedSessionId,
      normalizedClientMessageId,
    ) as Row[];
    return rows.map(messageFromRow);
  }

  findMessagesByResponseMessageId(
    userId: string,
    batchId: string,
    sessionId: string,
    responseMessageId: string,
  ): AgentMessage[] {
    this.#ensureOpen();
    const normalizedUserId = requiredText(userId, "userId");
    const normalizedBatchId = requiredText(batchId, "batchId");
    const normalizedSessionId = requiredText(sessionId, "sessionId");
    const normalizedResponseMessageId = requiredText(responseMessageId, "responseMessageId");
    if (!this.#sessionExists(normalizedUserId, normalizedBatchId, normalizedSessionId)) return [];
    const rows = this.#database.prepare(`
      SELECT * FROM agent_messages
      WHERE user_id = ? AND batch_id = ? AND session_id = ?
        AND json_extract(evidence_json, '$.responseMessageId') = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 2
    `).all(
      normalizedUserId,
      normalizedBatchId,
      normalizedSessionId,
      normalizedResponseMessageId,
    ) as Row[];
    return rows.map(messageFromRow);
  }

  audit(input: AuditInput): AuditEvent {
    this.#ensureOpen();
    const userId = requiredText(input.userId, "userId");
    const batchId = input.batchId ? requiredText(input.batchId, "batchId") : null;
    if (batchId && !this.getBatch(userId, batchId)) this.#batchNotFound();
    if (input.idempotencyKey) {
      const replay = this.#database.prepare(
        "SELECT * FROM audit_events WHERE user_id = ? AND idempotency_key = ?",
      ).get(userId, input.idempotencyKey) as Row | undefined;
      if (replay) {
        const result = auditFromRow(replay);
        if (result.batchId !== batchId) this.#idempotencyConflict();
        return result;
      }
    }
    const id = requiredText(input.id ?? randomUUID(), "id");
    const now = new Date().toISOString();
    const runAudit = () => {
      this.#database.prepare(
        "INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)",
      ).run(userId, now);
      this.#database.prepare(`
        INSERT INTO audit_events (
          user_id, id, batch_id, action, details_json, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        id,
        batchId,
        requiredText(input.action, "action"),
        serializeObject(input.details ?? {}, "details"),
        input.idempotencyKey ?? null,
        now,
      );
    };
    if (this.#transactionDepth > 0) runAudit();
    else this.#transaction(runAudit);
    const row = this.#database.prepare(
      "SELECT * FROM audit_events WHERE user_id = ? AND id = ?",
    ).get(userId, id) as Row;
    return auditFromRow(row);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new LocalStoreError("LOCAL_STORE_CLOSED");
  }

  #monotonicNow(): string {
    const current = Date.now();
    const next = Math.max(current, this.#lastMessageCreatedAtMs + 1);
    this.#lastMessageCreatedAtMs = next;
    return new Date(next).toISOString();
  }

  #transaction<T>(operation: () => T): T {
    this.#transactionDepth += 1;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  #confirmationReplayMatches(
    confirmation: DailyOperationConfirmation,
    expected: {
      batchId: string;
      dateLocal: string;
      planId: string;
      operationsSha256: string;
      confirmedBy: string;
      deviceSetting: DeviceSetting | null;
      decisionId: string | null;
    },
  ): boolean {
    if (confirmation.batchId !== expected.batchId ||
        confirmation.businessDate !== expected.dateLocal ||
        confirmation.planId !== expected.planId ||
        confirmation.operationsSha256 !== expected.operationsSha256 ||
        confirmation.confirmedBy !== expected.confirmedBy) {
      return false;
    }
    if (expected.deviceSetting === null) {
      if (confirmation.deviceSetting !== null) return false;
    } else if (JSON.stringify(confirmation.deviceSetting) !== JSON.stringify(expected.deviceSetting)) {
      return false;
    }
    return expected.decisionId === null || confirmation.decisionId === expected.decisionId;
  }

  #insertActiveDecisionLocked(input: {
    userId: string;
    batchId: string;
    dateLocal: string;
    decision: FeedingDecision;
    now: string;
  }): string {
    const revision = nonNegativeInteger(input.decision.revision, "decision.revision");
    const existing = this.#database.prepare(`
      SELECT id FROM feeding_decisions
      WHERE user_id = ? AND batch_id = ? AND date_local = ? AND revision = ?
    `).get(input.userId, input.batchId, input.dateLocal, revision) as Row | undefined;
    if (existing) {
      this.#database.prepare(`
        UPDATE feeding_decisions SET
          session_id = NULL,
          sop_version = ?,
          model_version = ?,
          calculation_date = ?,
          device_setting_json = ?,
          evidence_json = ?,
          decision_json = ?,
          status = ?,
          idempotency_key = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(
        requiredText(input.decision.evidence.sopVersion, "decision.evidence.sopVersion"),
        requiredText(input.decision.evidence.modelVersion, "decision.evidence.modelVersion"),
        requiredText(input.decision.evidence.calculationDate, "decision.evidence.calculationDate"),
        JSON.stringify(input.decision.setting),
        JSON.stringify(input.decision.evidence),
        serializeDecision(input.decision),
        input.decision.status,
        input.now,
        stringValue(existing.id, "feeding_decisions.id"),
      );
      return stringValue(existing.id, "feeding_decisions.id");
    }
    const id = randomUUID();
    if (input.decision.status === "active") {
      this.#database.prepare(`
        UPDATE feeding_decisions SET status = 'superseded', updated_at = ?
        WHERE user_id = ? AND batch_id = ? AND date_local = ? AND status = 'active'
      `).run(input.now, input.userId, input.batchId, input.dateLocal);
    }
    this.#database.prepare(`
      INSERT INTO feeding_decisions (
        user_id, id, batch_id, session_id, revision, date_local,
        sop_version, model_version, calculation_date, device_setting_json,
        evidence_json, decision_json, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.userId,
      id,
      input.batchId,
      null,
      revision,
      requiredText(input.dateLocal, "dateLocal"),
      requiredText(input.decision.evidence.sopVersion, "decision.evidence.sopVersion"),
      requiredText(input.decision.evidence.modelVersion, "decision.evidence.modelVersion"),
      requiredText(input.decision.evidence.calculationDate, "decision.evidence.calculationDate"),
      JSON.stringify(input.decision.setting),
      JSON.stringify(input.decision.evidence),
      serializeDecision(input.decision),
      input.decision.status,
      null,
      input.now,
      input.now,
    );
    return id;
  }

  #insertObservation(input: AppendDailyObservationInput): DailyObservation {
    const now = new Date().toISOString();
    const id = requiredText(input.id ?? randomUUID(), "id");
    this.#database.prepare(`
      INSERT INTO daily_observations (
        user_id, id, batch_id, date_local, observed_at, batch_revision,
        data_json, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requiredText(input.userId, "userId"),
      id,
      requiredText(input.batchId, "batchId"),
      requiredText(input.dateLocal, "dateLocal"),
      input.observedAt ?? now,
      nonNegativeInteger(input.batchRevision, "batchRevision"),
      serializeObject(input.data, "data"),
      requiredText(input.idempotencyKey, "idempotencyKey"),
      now,
    );
    const row = this.#database.prepare(
      "SELECT * FROM daily_observations WHERE user_id = ? AND id = ?",
    ).get(input.userId, id) as Row;
    return observationFromRow(row);
  }

  #sessionExists(userId: string, batchId: string, sessionId: string): boolean {
    return Boolean(this.#database.prepare(`
      SELECT 1 FROM agent_sessions
      WHERE user_id = ? AND batch_id = ? AND id = ?
    `).get(userId, batchId, sessionId));
  }

  #requireSession(userId: string, batchId: string, sessionId: string): void {
    if (!this.#sessionExists(userId, batchId, sessionId)) {
      throw new LocalStoreError("LOCAL_STORE_SESSION_NOT_FOUND");
    }
  }

  #batchNotFound(): never {
    throw new LocalStoreError("LOCAL_STORE_BATCH_NOT_FOUND");
  }

  #idempotencyConflict(): never {
    throw new LocalStoreError("LOCAL_STORE_IDEMPOTENCY_CONFLICT");
  }

  #staleRevision(current: number, received: number): never {
    throw new LocalStoreError(
      "LOCAL_STORE_STALE_REVISION",
      `stale revision: current ${current}, received ${received}`,
    );
  }
}

export function createLocalStore(options: LocalStoreOptions): LocalStore {
  return new SqliteLocalStore(options);
}

export type {
  AgentMessage,
  AgentSession,
  AppendDailyObservationInput,
  AppendMessageInput,
  AuditEvent,
  AuditInput,
  CommitModeSwitchInput,
  CreateBatchInput,
  CreateSessionInput,
  DailyObservation,
  ListMessagesOptions,
  LocalBatch,
  LocalSession,
  LocalSopTemplate,
  SopKnowledgeChunk,
  LocalStore,
  LocalStoreOptions,
  LocalUser,
  LocalUserRole,
  SaveDecisionInput,
} from "../shared/local-store-contract.js";
