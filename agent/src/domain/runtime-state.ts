/** Framework-free runtime latch state and transitions. */

export type DeviceRuntimeLatch = "normal" | "blocked" | "probe_contaminated";
export type FeedingRuntimeLatch = "normal" | "refusal";
export type RuntimeStateStatus = "normal" | "manual_hold" | "blocked";

export interface RuntimeState {
  readonly state: RuntimeStateStatus;
  readonly deviceLatch: DeviceRuntimeLatch;
  readonly feedingLatch: FeedingRuntimeLatch;
  readonly reasons: readonly string[];
  readonly sourceObservationIds: readonly string[];
}

export interface RuntimeObservationInput {
  readonly id?: string;
  readonly deviceStatus?: unknown;
  readonly feedingResponse?: unknown;
}

export const INITIAL_RUNTIME_STATE: RuntimeState = Object.freeze({
  state: "normal",
  deviceLatch: "normal",
  feedingLatch: "normal",
  reasons: Object.freeze([]),
  sourceObservationIds: Object.freeze([]),
});

function sourceIds(state: RuntimeState, id: string | undefined): readonly string[] {
  if (!id || state.sourceObservationIds.includes(id)) return state.sourceObservationIds;
  return [...state.sourceObservationIds, id];
}

function aggregate(
  deviceLatch: DeviceRuntimeLatch,
  feedingLatch: FeedingRuntimeLatch,
  reasons: readonly string[],
  sourceObservationIds: readonly string[],
): RuntimeState {
  return Object.freeze({
    state: deviceLatch === "normal"
      ? feedingLatch === "normal" ? "normal" : "manual_hold"
      : "blocked",
    deviceLatch,
    feedingLatch,
    reasons: Object.freeze([...reasons]),
    sourceObservationIds: Object.freeze([...sourceObservationIds]),
  });
}

function device(value: unknown): DeviceRuntimeLatch | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "normal" || value === "ok") return "normal";
  if (value === "blocked" || value === "offline") return "blocked";
  if (value === "probe_contaminated") return "probe_contaminated";
  throw new Error("DOMAIN_RUNTIME_DEVICE_INVALID");
}

function feeding(value: unknown): FeedingRuntimeLatch | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "normal" || value === "active" || value === "mixed") return "normal";
  if (value === "refusal" || value === "refusing") return "refusal";
  throw new Error("DOMAIN_RUNTIME_FEEDING_INVALID");
}

export function transitionRuntimeState(
  state: RuntimeState,
  input: RuntimeObservationInput,
): RuntimeState {
  const nextDevice = device(input.deviceStatus);
  const nextFeeding = feeding(input.feedingResponse);
  let deviceLatch = state.deviceLatch;
  let feedingLatch = state.feedingLatch;
  const reasons = new Set(state.reasons);
  if (nextDevice !== undefined) {
    deviceLatch = nextDevice;
    reasons.delete("device_blocked");
    reasons.delete("probe_contamination");
    if (nextDevice === "blocked") reasons.add("device_blocked");
    if (nextDevice === "probe_contaminated") reasons.add("probe_contamination");
  }
  if (nextFeeding !== undefined) {
    feedingLatch = nextFeeding;
    reasons.delete("feeding_refusal");
    if (nextFeeding === "refusal") reasons.add("feeding_refusal");
  }
  const changed = nextDevice !== undefined || nextFeeding !== undefined;
  return aggregate(deviceLatch, feedingLatch, [...reasons], sourceIds(state, changed ? input.id : undefined));
}

export function resolveRuntimeState(
  observations: readonly RuntimeObservationInput[],
  initial: RuntimeState = INITIAL_RUNTIME_STATE,
): RuntimeState {
  return observations.reduce(transitionRuntimeState, initial);
}

export const applyRuntimeObservation = transitionRuntimeState;
