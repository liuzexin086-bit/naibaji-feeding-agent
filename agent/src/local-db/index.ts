import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FeedingDecision } from "../shared/agent-v2-contract.js";
import type {
  AgentMessage,
  AgentSession,
  AppendDailyObservationInput,
  AppendMessageInput,
  AuditEvent,
  AuditInput,
  CreateBatchInput,
  CreateSessionInput,
  DailyObservation,
  ListMessagesOptions,
  LocalBatch,
  LocalStore,
  LocalStoreOptions,
  SaveDecisionInput,
} from "../shared/local-store-contract.js";
import { INITIAL_SCHEMA, MIGRATION_VERSION } from "./schema.js";

type Row = Record<string, unknown>;

export type LocalStoreErrorCode =
  | "LOCAL_STORE_CLOSED"
  | "LOCAL_STORE_BATCH_NOT_FOUND"
  | "LOCAL_STORE_SESSION_NOT_FOUND"
  | "LOCAL_STORE_STALE_REVISION"
  | "LOCAL_STORE_IDEMPOTENCY_CONFLICT"
  | "LOCAL_STORE_DECISION_CONFLICT"
  | "LOCAL_STORE_INVALID_INPUT";

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

function isMemoryFilename(filename: string): boolean {
  return filename === ":memory:" || filename.includes("mode=memory");
}

export class SqliteLocalStore implements LocalStore {
  readonly #database: DatabaseSync;
  #closed = false;

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
    this.#transaction(() => {
      this.#database.exec(INITIAL_SCHEMA);
      this.#database.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(MIGRATION_VERSION, new Date().toISOString());
    });
  }

  getBatch(userId: string, batchId: string): LocalBatch | null {
    this.#ensureOpen();
    const row = this.#database.prepare(
      "SELECT * FROM batches WHERE user_id = ? AND id = ?",
    ).get(requiredText(userId, "userId"), requiredText(batchId, "batchId")) as Row | undefined;
    return row ? batchFromRow(row) : null;
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
      input.observedAt ?? now,
      batchRevision,
      serializeObject(input.data, "data"),
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
      if (decision.status === "active") {
        this.#database.prepare(`
          UPDATE feeding_decisions SET status = 'superseded', updated_at = ?
          WHERE user_id = ? AND batch_id = ? AND date_local = ? AND status = 'active'
        `).run(now, userId, batchId, decision.dateLocal);
      }
      this.#database.prepare(`
        INSERT INTO feeding_decisions (
          user_id, id, batch_id, session_id, revision, date_local,
          sop_version, model_version, calculation_date, device_setting_json,
          evidence_json, decision_json, status, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        input.id ?? randomUUID(),
        batchId,
        input.sessionId ?? null,
        revision,
        requiredText(decision.dateLocal, "decision.dateLocal"),
        requiredText(decision.evidence.sopVersion, "decision.evidence.sopVersion"),
        requiredText(decision.evidence.modelVersion, "decision.evidence.modelVersion"),
        requiredText(decision.evidence.calculationDate, "decision.evidence.calculationDate"),
        JSON.stringify(decision.setting),
        JSON.stringify(decision.evidence),
        decisionJson,
        decision.status,
        input.idempotencyKey ?? null,
        now,
        now,
      );
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
    const now = new Date().toISOString();
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
      SELECT * FROM agent_messages
      WHERE user_id = ? AND batch_id = ? AND session_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(normalizedUserId, normalizedBatchId, normalizedSessionId, limit) as Row[];
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
    this.#transaction(() => {
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
    });
    const row = this.#database.prepare(
      "SELECT * FROM audit_events WHERE user_id = ? AND id = ?",
    ).get(userId, id) as Row;
    return auditFromRow(row);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new LocalStoreError("LOCAL_STORE_CLOSED");
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
  CreateBatchInput,
  CreateSessionInput,
  DailyObservation,
  ListMessagesOptions,
  LocalBatch,
  LocalStore,
  LocalStoreOptions,
  SaveDecisionInput,
} from "../shared/local-store-contract.js";
