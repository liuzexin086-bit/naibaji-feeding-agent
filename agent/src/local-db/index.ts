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
  BatchListOptions,
  CommitAdvanceInput,
  CommitRecordInput,
  CommitResult,
  CreateBatchInput,
  CreateSessionInput,
  DailyObservation,
  ListMessagesOptions,
  LocalBatch,
  LocalSession,
  LocalSopTemplate,
  LocalStore,
  LocalStoreOptions,
  LocalUser,
  LocalUserRole,
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
  | "LOCAL_STORE_USER_EXISTS"
  | "LOCAL_STORE_USER_NOT_FOUND"
  | "LOCAL_STORE_USER_SELF_DELETE"
  | "LOCAL_STORE_USER_CONFIRM_MISMATCH"
  | "LOCAL_STORE_LAST_ADMIN"
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
      this.#database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx
          ON users(email) WHERE email IS NOT NULL;
      `);
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

  listObservations(userId: string, batchId: string): DailyObservation[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM daily_observations
      WHERE user_id = ? AND batch_id = ?
      ORDER BY json_extract(data_json, '$.dayIndex') ASC, created_at ASC
    `).all(
      requiredText(userId, "userId"),
      requiredText(batchId, "batchId"),
    ) as Row[];
    return rows.map(observationFromRow);
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

  listSopTemplates(): LocalSopTemplate[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(
      "SELECT * FROM sop_templates ORDER BY created_at DESC, id DESC",
    ).all() as Row[];
    return rows.map(sopTemplateFromRow);
  }

  createSopTemplate(input: {
    id?: string;
    version: string;
    name: string;
    config: Record<string, unknown>;
    createdBy: string;
    sourceTemplateId?: string | null;
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
        id, version, name, config_json, created_by, source_template_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      version,
      name,
      serializeObject(input.config, "config"),
      createdBy,
      input.sourceTemplateId ?? null,
      now,
    );
    const row = this.#database.prepare(
      "SELECT * FROM sop_templates WHERE id = ?",
    ).get(id) as Row;
    return sopTemplateFromRow(row);
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
    const resultJson = serializeObject(input.result, "result");
    const observation = {
      ...input.observation,
      dayIndex: Number(input.observation.dayIndex ?? batch.currentDay),
      revision: expected,
    };
    this.#transaction(() => {
      this.#insertObservation({
        userId,
        batchId,
        dateLocal: requiredText(input.dateLocal, "dateLocal"),
        observedAt: input.observedAt ?? now,
        batchRevision: expected,
        data: observation,
        idempotencyKey: key,
      });
      const update = this.#database.prepare(`
        UPDATE batches
        SET revision = ?, current_day = ?, data_json = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND revision = ?
      `).run(
        expected + 1,
        nonNegativeInteger(input.nextDayIndex, "nextDayIndex"),
        serializeObject(input.nextData, "nextData"),
        now,
        userId,
        batchId,
        expected,
      );
      if (Number(update.changes) !== 1) this.#staleRevision(expected + 1, expected);
      this.#database.prepare(`
        INSERT INTO operation_results (
          user_id, batch_id, operation, idempotency_key, response_json, created_at
        ) VALUES (?, ?, 'advance', ?, ?, ?)
      `).run(userId, batchId, key, resultJson, now);
    });
    return { replayed: false, result: input.result };
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
    const resultJson = serializeObject(input.result, "result");
    this.#transaction(() => {
      this.#insertObservation({
        userId,
        batchId,
        dateLocal: requiredText(input.dateLocal, "dateLocal"),
        observedAt: input.observedAt ?? now,
        batchRevision: expected,
        data: { ...input.observation, revision: expected },
        idempotencyKey: key,
      });
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
      this.#database.prepare(`
        INSERT INTO operation_results (
          user_id, batch_id, operation, idempotency_key, response_json, created_at
        ) VALUES (?, ?, 'record', ?, ?, ?)
      `).run(userId, batchId, key, resultJson, now);
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
      ORDER BY created_at ASC, rowid ASC
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
  CreateBatchInput,
  CreateSessionInput,
  DailyObservation,
  ListMessagesOptions,
  LocalBatch,
  LocalSession,
  LocalSopTemplate,
  LocalStore,
  LocalStoreOptions,
  LocalUser,
  LocalUserRole,
  SaveDecisionInput,
} from "../shared/local-store-contract.js";
