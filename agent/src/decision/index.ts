export {
  computeDayDecision,
  creepGrade,
  majorityCreepGrade,
  previewDiarrheaAdjustment,
} from "./core.js";

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
} from "../shared/agent-v2-contract.js";

export { CREEP_GRADE_VALUES } from "../shared/agent-v2-contract.js";
