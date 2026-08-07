import type {
  CreepGrade,
  DeviceSetting,
  DeviceWindow,
  DiarrheaGrade,
  FeedingDecision,
  FeedingMode,
  TimedMeal,
} from "./agent-v2-contract.js";

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
  status: "draft" | "published" | "failed";
  sourceMarkdown: string;
  sourceSha256: string;
  collectionRevision: string;
  parserVersion: string;
  embeddingModel: string;
  chunkCount: number;
  publishedAt: string | null;
  indexError: string | null;
}

export type SopEditTaskStatus = "drafting" | "draft_ready" | "draft_failed" | "published" | "rejected";

export interface SopEditTask {
  id: string;
  templateId: string | null;
  instruction: string;
  status: SopEditTaskStatus;
  proposedMarkdown: string | null;
  proposedConfig: Record<string, unknown> | null;
  changeSummary: string | null;
  affectedSections: string[];
  errorCode: string | null;
  publishedTemplateId: string | null;
  createdBy: string;
  confirmedBy: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface SopKnowledgeChunk {
  templateId: string;
  chunkId: string;
  sectionId: string;
  chunkIndex: number;
  title: string;
  text: string;
  sourceSha256: string;
  collectionRevision: string;
  lexicalTerms: string[];
}

export interface FrozenSopKnowledge {
  templateId: string;
  sopVersion: string;
  sourceSha256: string;
  collectionRevision: string;
  parserVersion: string;
  embeddingModel: string;
}

export interface TimedQuantityTemplateSnapshot {
  mealTimes: string[];
  excludedMealTimes: string[];
  precisionGrams: number;
  /** Times are disabled in this order; surviving times retain their original order. */
  reductionPriority: string[];
}

export type FreeFeedingSlotNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Immutable SOP row. All eight rows are frozen even when a row is disabled. */
export interface FreeFeedingSlot extends DeviceWindow {
  slot: FreeFeedingSlotNumber;
  enabled: boolean;
  label?: string;
}

export interface FreeFeedingTemplateSnapshot {
  slots: FreeFeedingSlot[];
  /** Derived from enabled slots only; this is the only window list sent to the deterministic core. */
  windows: DeviceWindow[];
  /** Optional frozen SOP reduction priority, keyed by window startLocal. */
  reductionPriority?: string[];
  stageConditions: Record<string, unknown>;
  exceptionBlockers: string[];
}

export interface DevicePlanSnapshot {
  version: string;
  sha256: string;
  firstDay: {
    mode: "timed_quantity";
    mealTimes: string[];
  };
  templates: {
    timed_quantity: TimedQuantityTemplateSnapshot;
    free_feeding: FreeFeedingTemplateSnapshot;
  };
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
  feedbackBatch?: LocalBatch;
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
  feedbackBatch?: LocalBatch;
}

export interface CommitModeSwitchInput {
  userId: string;
  batchId: string;
  expectedRevision: number;
  idempotencyKey: string;
  fromMode: FeedingMode;
  toMode: FeedingMode;
  devicePlanVersion: string;
  devicePlanSha256: string;
  nextData: Record<string, unknown>;
  result: Record<string, unknown>;
}

/**
 * Administrator-approved replacement of the frozen SOP snapshot for one
 * active batch. A pending current-day operation plan may be refreshed in the
 * same transaction; a confirmed plan is never rewritten.
 */
export interface CommitSopMigrationInput {
  userId: string;
  batchId: string;
  expectedRevision: number;
  idempotencyKey: string;
  actorUserId: string;
  targetTemplateId: string;
  nextData: Record<string, unknown>;
  result: Record<string, unknown>;
  auditDetails: Record<string, unknown>;
  replacementDailyOperationPlan?: EnsureDailyOperationPlanInput;
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

export type FeedbackOriginKind = "diarrhea" | "creep_control";

export interface FeedbackDeviceProposal {
  kind: FeedbackOriginKind;
  businessDate: string;
  mode: FeedingMode;
  dayAge: number;
  dailyPowderGrams: number;
  singlePowderGrams: number;
  mealCount: number;
  timedMeals: TimedMeal[];
  freeWindows: DeviceWindow[];
  precisionGrams: number;
  source: DeviceSetting["source"];
  rationale: string[];
  manualDispositionRequired: boolean;
  proposalDigest: string;
  cumulativePowderGrams?: number;
  resultKind?: "individual_intervention" | "feeding_reduction_proposal" | "manual_only";
  adjustedProgramTotal?: number;
  remainingDeliverable?: number;
  targetSlot?: string;
  targetAlreadyHappened?: boolean;
  controlStartDay?: number;
}

export interface FeedbackOrigin {
  id: string;
  kind: FeedbackOriginKind;
  businessDate: string;
  status: "proposed" | "manual" | "applied";
  sourceObservation: {
    recordedAt: string;
    diarrheaGrade?: DiarrheaGrade;
    creepGrade?: CreepGrade;
    actualPowderGrams?: number | null;
  };
  reason: string;
  proposal?: FeedbackDeviceProposal | null;
  controlStartDay?: number;
  createdAt: string;
}

export interface DailyOperationItem {
  code: string;
  title: string;
  dueWindow: { startLocal: string; endLocal: string; endDayOffset?: 0 | 1 };
  sopSection: string;
  requiredObservationFields: string[];
  safetyNotes: string[];
  feedbackRef?: {
    originId: string;
    kind: FeedbackOriginKind;
    proposalDigest?: string;
    requiresDeviceConfirmation: boolean;
  };
}

export interface DailyOperationPlan {
  id: string;
  userId: string;
  batchId: string;
  businessDate: string;
  basedOnBatchRevision: number;
  sopTemplateId: string;
  sopSourceSha256: string;
  devicePlanVersion: string;
  devicePlanSha256: string;
  selectedMode: FeedingMode;
  effectiveMode: FeedingMode;
  operations: DailyOperationItem[];
  operationsSha256: string;
  status: "pending" | "confirmed";
  proposedSetting: FeedbackDeviceProposal | null;
  feedbackOrigin: FeedbackOrigin | null;
  createdAt: string;
}

export interface DailyOperationConfirmation {
  id: string;
  planId: string;
  userId: string;
  batchId: string;
  businessDate: string;
  operationsSha256: string;
  confirmedBy: string;
  confirmedAt: string;
  idempotencyKey: string;
  deviceSetting: DeviceSetting | null;
  decisionId: string | null;
}

export type DailyOperationAmendmentStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "applied"
  | "superseded"
  | "cancelled";

export interface DailyOperationAmendment {
  id: string;
  userId: string;
  batchId: string;
  businessDate: string;
  basePlanId: string;
  baseConfirmationId: string | null;
  originId: string;
  originKind: FeedbackOriginKind;
  severity: "mild" | "moderate" | "severe" | null;
  priority: "routine" | "warning" | "critical";
  status: DailyOperationAmendmentStatus;
  operations: DailyOperationItem[];
  proposal: FeedbackDeviceProposal | null;
  decisionId: string | null;
  amendmentSha256: string;
  basedOnBatchRevision: number;
  idempotencyKey: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface EnsureDailyOperationAmendmentInput {
  id?: string;
  userId: string;
  batchId: string;
  businessDate: string;
  basePlanId: string;
  baseConfirmationId: string | null;
  originId: string;
  originKind: FeedbackOriginKind;
  severity: "mild" | "moderate" | "severe" | null;
  priority: "routine" | "warning" | "critical";
  operations: DailyOperationItem[];
  proposal?: FeedbackDeviceProposal | null;
  basedOnBatchRevision: number;
  idempotencyKey: string;
}

export interface DecideDailyOperationAmendmentInput {
  userId: string;
  batchId: string;
  amendmentId: string;
  action: "confirm" | "reject" | "apply" | "cancel";
  decidedBy: string;
  expectedRevision: number;
  expectedAmendmentSha256: string;
  idempotencyKey: string;
}

export interface EnsureDailyOperationPlanInput {
  id?: string;
  userId: string;
  batchId: string;
  businessDate: string;
  basedOnBatchRevision: number;
  sopTemplateId: string;
  sopSourceSha256: string;
  devicePlanVersion: string;
  devicePlanSha256: string;
  selectedMode: FeedingMode;
  effectiveMode: FeedingMode;
  operations: DailyOperationItem[];
  operationsSha256: string;
  proposedSetting?: FeedbackDeviceProposal | null;
  feedbackOrigin?: FeedbackOrigin | null;
}

export interface ConfirmDailyOperationPlanInput {
  id?: string;
  userId: string;
  batchId: string;
  businessDate: string;
  planId: string;
  operationsSha256: string;
  confirmedBy: string;
  idempotencyKey: string;
  /** Optional operator context, retained only in the audit event. */
  note?: string;
  /** Service-side derived setting; clients must not supply a trusted value. */
  deviceSetting?: DeviceSetting;
  decisionId?: string | null;
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
  /** Administrator-only callers must enforce authorization before using this. */
  listAllBatches(options?: BatchListOptions): LocalBatch[];
  listObservations(userId: string, batchId: string): DailyObservation[];
  getDailyOperationPlan(userId: string, batchId: string, businessDate: string): DailyOperationPlan | null;
  getDailyOperationConfirmation(
    userId: string,
    batchId: string,
    businessDate: string,
  ): DailyOperationConfirmation | null;
  ensureDailyOperationPlan(input: EnsureDailyOperationPlanInput): DailyOperationPlan;
  confirmDailyOperationPlan(input: ConfirmDailyOperationPlanInput): {
    confirmation: DailyOperationConfirmation;
    replayed: boolean;
  };
  getDailyOperationAmendments(
    userId: string,
    batchId: string,
    businessDate: string,
  ): DailyOperationAmendment[];
  getDailyOperationAmendment(
    userId: string,
    batchId: string,
    amendmentId: string,
  ): DailyOperationAmendment | null;
  supersedeDailyOperationAmendments(input: {
    userId: string;
    batchId: string;
    businessDate: string;
    originKind?: FeedbackOriginKind;
    excludeAmendmentId?: string;
    reason?: "explicit_none" | "newer_observation" | "batch_change";
    sourceObservationId?: string;
    replacementAmendmentId?: string | null;
  }): number;
  ensureDailyOperationAmendment(
    input: EnsureDailyOperationAmendmentInput,
  ): { amendment: DailyOperationAmendment; replayed: boolean };
  decideDailyOperationAmendment(
    input: DecideDailyOperationAmendmentInput,
  ): { amendment: DailyOperationAmendment; replayed: boolean };
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
  findMessagesByClientMessageId(
    userId: string,
    batchId: string,
    sessionId: string,
    clientMessageId: string,
  ): AgentMessage[];
  findMessagesByResponseMessageId(
    userId: string,
    batchId: string,
    sessionId: string,
    responseMessageId: string,
  ): AgentMessage[];
  audit(input: AuditInput): AuditEvent;
  getUserByEmail(email: string): LocalUser | null;
  getUserById(userId: string): LocalUser | null;
  listUsers(): LocalUser[];
  createUser(input: {
    id?: string;
    email: string;
    passwordHash: string;
    passwordSalt: string;
    role?: LocalUserRole;
  }): LocalUser;
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
  deleteUser(input: {
    userId: string;
    actorUserId: string;
    confirmEmail: string;
  }): void;
  listSopTemplates(): LocalSopTemplate[];
  getPublishedSopTemplate(): LocalSopTemplate | null;
  getSopTemplate(templateId: string): LocalSopTemplate | null;
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
  }): LocalSopTemplate;
  publishSopTemplate(input: {
    templateId: string;
    chunks: SopKnowledgeChunk[];
  }): LocalSopTemplate;
  failSopTemplate(templateId: string, error: string): LocalSopTemplate;
  listSopKnowledgeChunks(templateId: string): SopKnowledgeChunk[];
  createSopEditTask(input: {
    id?: string;
    templateId: string | null;
    instruction: string;
    createdBy: string;
  }): SopEditTask;
  getSopEditTask(taskId: string): SopEditTask | null;
  listSopEditTasks(limit?: number): SopEditTask[];
  completeSopEditTaskDraft(input: {
    taskId: string;
    proposedMarkdown: string;
    proposedConfig: Record<string, unknown>;
    changeSummary: string;
    affectedSections: string[];
  }): SopEditTask;
  failSopEditTaskDraft(input: {
    taskId: string;
    errorCode: string;
  }): SopEditTask;
  publishSopEditTask(input: {
    taskId: string;
    publishedTemplateId: string;
    confirmedBy: string;
  }): SopEditTask;
  rejectSopEditTask(input: {
    taskId: string;
    rejectedBy: string;
  }): SopEditTask;
  commitAdvance(input: CommitAdvanceInput): CommitResult;
  commitRecord(input: CommitRecordInput): CommitResult;
  commitModeSwitch(input: CommitModeSwitchInput): CommitResult;
  commitSopMigration(input: CommitSopMigrationInput): CommitResult;
}
