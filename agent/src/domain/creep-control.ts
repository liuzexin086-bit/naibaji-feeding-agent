/** Explicit server-owned creep-control state and monotonic transition. */

import type { CreepGrade } from "./observation.js";

export type CreepControlStatus = "inactive" | "active";
export const CREEP_CONTROL_POLICY_VERSION = "creep-control-v2" as const;

export interface CreepControlState {
  readonly status: CreepControlStatus;
  readonly startDay: number | null;
  readonly triggerGrade: CreepGrade | null;
  readonly policyVersion: typeof CREEP_CONTROL_POLICY_VERSION;
}

export interface CreepControlTransitionInput {
  readonly currentDay: number;
  readonly sustainedGrade: CreepGrade;
}

export const INACTIVE_CREEP_CONTROL: CreepControlState = Object.freeze({
  status: "inactive",
  startDay: null,
  triggerGrade: null,
  policyVersion: CREEP_CONTROL_POLICY_VERSION,
});

const GRADE_ORDER: readonly CreepGrade[] = ["none", "low", "medium", "high", "excellent"];

function validDay(day: number): void {
  if (!Number.isSafeInteger(day) || day < 0) throw new Error("DOMAIN_CREEP_DAY_INVALID");
}

function validGrade(grade: unknown): grade is CreepGrade {
  return typeof grade === "string" && GRADE_ORDER.includes(grade as CreepGrade);
}

export function createCreepControlState(raw?: Partial<CreepControlState>): CreepControlState {
  if (raw === undefined) return INACTIVE_CREEP_CONTROL;
  if (raw.policyVersion !== CREEP_CONTROL_POLICY_VERSION) {
    throw new Error("DOMAIN_CREEP_POLICY_UNSUPPORTED");
  }
  const status = raw?.status ?? "inactive";
  if (status !== "inactive" && status !== "active") throw new Error("DOMAIN_CREEP_STATUS_INVALID");
  const startDay = raw?.startDay ?? null;
  if (startDay !== null) validDay(startDay);
  const triggerGrade = raw?.triggerGrade ?? null;
  if (triggerGrade !== null && !validGrade(triggerGrade)) throw new Error("DOMAIN_CREEP_GRADE_INVALID");
  if (status === "active" && (startDay === null || triggerGrade === null)) {
    throw new Error("DOMAIN_CREEP_STATE_INVALID");
  }
  if (status === "inactive" && (startDay !== null || triggerGrade !== null)) {
    throw new Error("DOMAIN_CREEP_STATE_INVALID");
  }
  return Object.freeze({ status, startDay, triggerGrade, policyVersion: CREEP_CONTROL_POLICY_VERSION });
}

export function transitionCreepControl(
  state: CreepControlState,
  input: CreepControlTransitionInput,
): CreepControlState {
  if (state.policyVersion !== CREEP_CONTROL_POLICY_VERSION) throw new Error("DOMAIN_CREEP_POLICY_UNSUPPORTED");
  validDay(input.currentDay);
  if (!validGrade(input.sustainedGrade)) throw new Error("DOMAIN_CREEP_GRADE_INVALID");
  if (state.status === "active") return Object.freeze({ ...state });
  if (input.sustainedGrade === "none") return Object.freeze({ ...state });
  return createCreepControlState({
    status: "active",
    startDay: input.currentDay + 1,
    triggerGrade: input.sustainedGrade,
    policyVersion: CREEP_CONTROL_POLICY_VERSION,
  });
}

export function isCreepControlActive(state: CreepControlState): boolean {
  return state.status === "active" && state.startDay !== null;
}

export function creepGradeAtLeast(left: CreepGrade, right: CreepGrade): boolean {
  if (!validGrade(left) || !validGrade(right)) throw new Error("DOMAIN_CREEP_GRADE_INVALID");
  return GRADE_ORDER.indexOf(left) >= GRADE_ORDER.indexOf(right);
}
