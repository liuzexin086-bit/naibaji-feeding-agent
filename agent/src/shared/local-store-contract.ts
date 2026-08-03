import type { FeedingDecision } from "./agent-v2-contract.js";

export interface LocalStoreOptions {
  filename: string;
}

export type LocalUserRole = "admin" | "operator";

export interface LocalUser {
  id: string;
  email: string;
  role: LocalUserRole;
  createdAt: string;
  disabled: boolean;
}

export interface LocalSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface LocalSopTemplate {
  id: string;
  version: string;
  name: string;
  config: Record<string, unknown>;
  createdBy: string;
  sourceTemplateId: string | null;
  createdAt: string;
}

export interface LocalBatch {
  userId: string;
  batchId: string;
  revision: number;
  currentDay: number;
  status: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BatchListOptions {
  limit?: number;
}

export interface CommitAdvanceInput {
  userId: string;
  batchId: string;
  expectedRevision: number;
  idempotencyKey: string;
  dateLocal: string;
  observedAt?: string;
  observation: Record<string, unknown>;
  nextDayIndex: number;
  nextData: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface CommitRecordInput {
  userId: string;
  batchId: string;
  expectedRevision: number;
  idempotencyKey: string;
  dateLocal: string;
  observedAt?: string;
  observation: Record<string, unknown>;
  nextData: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface CommitResult {
  replayed: boolean;
  result: Record<string, unknown>;
}

export interface CreateBatchInput {
  userId: string;
  batchId: string;
  revision?: number;
  currentDay?: number;
  status?: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DailyObservation {
  id: string;
  userId: string;
  batchId: string;
  dateLocal: string;
  observedAt: string;
  batchRevision: number;
  data: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
}

export interface AppendDailyObservationInput {
  userId: string;
  batchId: string;
  dateLocal: string;
  observedAt?: string;
  batchRevision: number;
  data: Record<string, unknown>;
  id?: string;
  idempotencyKey: string;
}

export interface SaveDecisionInput {
  userId: string;
  decision: FeedingDecision;
  id?: string;
  sessionId?: string;
  idempotencyKey?: string;
}

export interface AgentSession {
  id: string;
  userId: string;
  batchId: string;
  status: "active" | "closed";
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  batchId: string;
  status?: "active" | "closed";
  provider?: string;
  model?: string;
  idempotencyKey?: string;
}

export type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export interface AgentMessage {
  id: string;
  userId: string;
  batchId: string;
  sessionId: string;
  role: AgentMessageRole;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface AppendMessageInput {
  id?: string;
  userId: string;
  batchId: string;
  sessionId: string;
  role: AgentMessageRole;
  content: string;
  toolName?: string;
  toolCallId?: string;
  evidence?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ListMessagesOptions {
  limit?: number;
}

export interface AuditEvent {
  id: string;
  userId: string;
  batchId: string | null;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AuditInput {
  id?: string;
  userId: string;
  batchId?: string;
  action: string;
  details?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface LocalStore {
  close(): void;
  migrate(): void;
  getBatch(userId: string, batchId: string): LocalBatch | null;
  listBatches(userId: string, options?: BatchListOptions): LocalBatch[];
  listObservations(userId: string, batchId: string): DailyObservation[];
  createBatch(input: CreateBatchInput): LocalBatch;
  appendDailyObservation(input: AppendDailyObservationInput): DailyObservation;
  saveDecision(input: SaveDecisionInput): FeedingDecision;
  getActiveDecision(
    userId: string,
    batchId: string,
    dateLocal?: string,
  ): FeedingDecision | null;
  createSession(input: CreateSessionInput): AgentSession;
  listSessions(userId: string, batchId: string): AgentSession[];
  appendMessage(input: AppendMessageInput): AgentMessage;
  listMessages(
    userId: string,
    batchId: string,
    sessionId: string,
    options?: ListMessagesOptions,
  ): AgentMessage[];
  audit(input: AuditInput): AuditEvent;
  getUserByEmail(email: string): LocalUser | null;
  getUserById(userId: string): LocalUser | null;
  ensureUser(input: {
    id?: string;
    email: string;
    passwordHash: string;
    passwordSalt: string;
    role?: LocalUserRole;
  }): LocalUser;
  createAuthSession(input: {
    userId: string;
    id?: string;
    tokenHash: string;
    expiresAt: string;
  }): LocalSession;
  getAuthSession(tokenHash: string): LocalSession | null;
  revokeAuthSession(tokenHash: string, revokedAt?: string): void;
  listSopTemplates(): LocalSopTemplate[];
  createSopTemplate(input: {
    id?: string;
    version: string;
    name: string;
    config: Record<string, unknown>;
    createdBy: string;
    sourceTemplateId?: string | null;
  }): LocalSopTemplate;
  commitAdvance(input: CommitAdvanceInput): CommitResult;
  commitRecord(input: CommitRecordInput): CommitResult;
}
