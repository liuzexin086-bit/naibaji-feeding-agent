export {
  computeDayDecision,
  creepGrade,
  majorityCreepGrade,
  previewDiarrheaAdjustment,
} from "./core.js";

export { resolveRuntimeState } from "./runtime-state.js";

export type {
  CreepGrade,
  ExceptionAction,
  ExceptionActionType,
  DayDecisionInput,
  DeviceSetting,
  DeviceWindow,
  DiarrheaAdjustmentInput,
  DiarrheaAdjustmentResult,
  DiarrheaGrade,
  FeedingDecision,
  FeedingMode,
  RuntimeExecutionState,
  RuntimeStateStatus,
} from "../shared/agent-v2-contract.js";

export { CREEP_GRADE_VALUES } from "../shared/agent-v2-contract.js";
