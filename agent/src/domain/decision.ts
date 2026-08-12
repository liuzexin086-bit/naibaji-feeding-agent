/** Framework-free planned/active decision contract. */

export type FeedingMode = "timed_quantity" | "free_feeding";
export type DecisionStatus = "planned" | "active" | "superseded";

export interface DecisionEvidence {
  readonly policyVersion: string;
  readonly modelVersion: string;
  readonly sopVersion: string;
  readonly modelSha256?: string;
  readonly sopSha256?: string;
}

export interface FeedingDecision {
  readonly id?: string;
  readonly batchId: string;
  readonly businessDate: string;
  readonly revision: number;
  readonly mode: FeedingMode;
  readonly status: DecisionStatus;
  readonly evidence: DecisionEvidence;
  readonly setting: Readonly<Record<string, unknown>>;
}

export interface DecisionState {
  readonly plannedDecision: FeedingDecision;
  readonly activeDecision: FeedingDecision | null;
}

export interface DecisionProjection {
  readonly plannedDecision: FeedingDecision;
  readonly activeDecision: FeedingDecision | null;
  readonly previewDecision: FeedingDecision;
  readonly previewSource: "planned";
  readonly isApplied: false;
}

function validDecision(decision: FeedingDecision, expectedStatus?: DecisionStatus): FeedingDecision {
  if (!decision.batchId.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(decision.businessDate)) {
    throw new Error("DOMAIN_DECISION_IDENTITY_INVALID");
  }
  if (!Number.isSafeInteger(decision.revision) || decision.revision < 0) {
    throw new Error("DOMAIN_DECISION_REVISION_INVALID");
  }
  if (decision.mode !== "timed_quantity" && decision.mode !== "free_feeding") {
    throw new Error("DOMAIN_DECISION_MODE_INVALID");
  }
  if (expectedStatus && decision.status !== expectedStatus) throw new Error("DOMAIN_DECISION_STATUS_INVALID");
  if (!decision.evidence || typeof decision.evidence.policyVersion !== "string" ||
      typeof decision.evidence.modelVersion !== "string" || typeof decision.evidence.sopVersion !== "string") {
    throw new Error("DOMAIN_DECISION_EVIDENCE_INVALID");
  }
  return Object.freeze({ ...decision, setting: Object.freeze({ ...decision.setting }) });
}

export function createDecisionState(input: {
  plannedDecision: FeedingDecision;
  activeDecision?: FeedingDecision | null;
}): DecisionState {
  const plannedDecision = validDecision(input.plannedDecision, "planned");
  const activeDecision = input.activeDecision == null
    ? null
    : validDecision(input.activeDecision, "active");
  if (activeDecision && (activeDecision.batchId !== plannedDecision.batchId ||
      activeDecision.businessDate !== plannedDecision.businessDate)) {
    throw new Error("DOMAIN_DECISION_SCOPE_MISMATCH");
  }
  return Object.freeze({ plannedDecision, activeDecision });
}

export function planDecision(decision: FeedingDecision): FeedingDecision {
  return validDecision({ ...decision, status: "planned" }, "planned");
}

export function activateDecision(
  state: DecisionState,
  decision: FeedingDecision,
): DecisionState {
  const active = validDecision({ ...decision, status: "active" }, "active");
  if (active.batchId !== state.plannedDecision.batchId || active.businessDate !== state.plannedDecision.businessDate) {
    throw new Error("DOMAIN_DECISION_SCOPE_MISMATCH");
  }
  return Object.freeze({ ...state, activeDecision: active });
}

export function projectDecision(state: DecisionState): DecisionProjection {
  return Object.freeze({
    plannedDecision: state.plannedDecision,
    activeDecision: state.activeDecision,
    previewDecision: state.plannedDecision,
    previewSource: "planned",
    isApplied: false,
  });
}

export function appliedDecision(state: DecisionState): FeedingDecision | null {
  return state.activeDecision;
}

export function isApplied(state: DecisionState): boolean {
  return state.activeDecision !== null;
}
