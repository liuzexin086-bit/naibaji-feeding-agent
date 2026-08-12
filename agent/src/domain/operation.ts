/** Framework-free daily operation and amendment state machine. */

export type OperationPlanStatus = "planned" | "confirmed";
export type OperationState = "planned" | "confirmed" | "applied" | "rejected" | "cancelled";

export interface OperationItem {
  readonly code: string;
  readonly title: string;
}

export interface OperationPlan {
  readonly id: string;
  readonly batchId: string;
  readonly businessDate: string;
  readonly revision: number;
  readonly operations: readonly OperationItem[];
  readonly status: OperationPlanStatus;
}

export interface OperationAction {
  readonly state: OperationState;
  readonly actor: string;
  readonly at: string;
}

export interface OperationTransition {
  readonly operation: OperationPlan;
  readonly history: readonly OperationAction[];
}

function validPlan(plan: OperationPlan): OperationPlan {
  if (!plan.id.trim() || !plan.batchId.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(plan.businessDate)) {
    throw new Error("DOMAIN_OPERATION_IDENTITY_INVALID");
  }
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 0) throw new Error("DOMAIN_OPERATION_REVISION_INVALID");
  if (plan.status !== "planned" && plan.status !== "confirmed") throw new Error("DOMAIN_OPERATION_STATUS_INVALID");
  return Object.freeze({ ...plan, operations: Object.freeze([...plan.operations]) });
}

export function createOperationPlan(plan: OperationPlan): OperationTransition {
  return Object.freeze({ operation: validPlan(plan), history: Object.freeze([]) });
}

function transition(
  current: OperationTransition,
  next: OperationState,
  actor: string,
  at: string,
): OperationTransition {
  if (!actor.trim() || !at.trim()) throw new Error("DOMAIN_OPERATION_ACTOR_INVALID");
  const currentState: OperationState = current.operation.status === "planned"
    ? "planned"
    : current.history.at(-1)?.state ?? "confirmed";
  const allowed =
    (currentState === "planned" && next === "confirmed") ||
    (currentState === "confirmed" && (next === "applied" || next === "rejected" || next === "cancelled"));
  if (!allowed) throw new Error("DOMAIN_OPERATION_TRANSITION_INVALID");
  const operation = next === "confirmed"
    ? Object.freeze({ ...current.operation, status: "confirmed" as const })
    : current.operation;
  return Object.freeze({
    operation,
    history: Object.freeze([...current.history, Object.freeze({ state: next, actor, at })]),
  });
}

export function confirmOperation(current: OperationTransition, actor: string, at: string): OperationTransition {
  return transition(current, "confirmed", actor, at);
}

export function applyOperation(current: OperationTransition, actor: string, at: string): OperationTransition {
  return transition(current, "applied", actor, at);
}

export function rejectOperation(current: OperationTransition, actor: string, at: string): OperationTransition {
  return transition(current, "rejected", actor, at);
}

export function cancelOperation(current: OperationTransition, actor: string, at: string): OperationTransition {
  return transition(current, "cancelled", actor, at);
}

export function operationState(current: OperationTransition): OperationState {
  return current.history.at(-1)?.state ?? current.operation.status;
}
