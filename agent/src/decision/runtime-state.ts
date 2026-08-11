import {
  normalizeIsoTimestamp,
  timestampOrderValue,
} from "../shared/iso-time.js";
import type {
  DeviceRuntimeLatch,
  FeedingRuntimeLatch,
  RuntimeExecutionState,
} from "../shared/agent-v2-contract.js";

type JsonObject = Record<string, unknown>;

function validRecords(records: JsonObject[]): JsonObject[] {
  return records.filter((row) =>
    normalizeIsoTimestamp(row.recordedAt ?? row.created_at) !== null);
}

function sortedRecords(records: JsonObject[]): JsonObject[] {
  return [...validRecords(records)].sort((left, right) => {
    const leftAt = String(left.recordedAt ?? left.created_at ?? "");
    const rightAt = String(right.recordedAt ?? right.created_at ?? "");
    const leftMs = timestampOrderValue(leftAt);
    const rightMs = timestampOrderValue(rightAt);
    if (leftMs !== rightMs) return leftMs - rightMs;
    return leftAt.localeCompare(rightAt) ||
      String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
  });
}

function canonicalDeviceLatch(value: unknown): DeviceRuntimeLatch | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "blocked") return "blocked";
  if (value === "probe_contaminated") return "probe_contaminated";
  if (value === "normal" || value === "ok") return "normal";
  if (value === "offline") return "blocked";
  return undefined;
}

function canonicalFeedingLatch(value: unknown): FeedingRuntimeLatch | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "refusal" || value === "refusing") return "refusal";
  if (value === "normal" || value === "active" || value === "mixed") return "normal";
  return undefined;
}

function observationIdOf(row: JsonObject): string | undefined {
  const id = String(row.observationId ?? row.id ?? "");
  return id.trim() ? id.trim() : undefined;
}

function addSourceId(ids: string[], row: JsonObject): void {
  const id = observationIdOf(row);
  if (id && !ids.includes(id)) ids.push(id);
}

export function resolveRuntimeState(records: JsonObject[]): RuntimeExecutionState {
  const sorted = sortedRecords(records);
  let deviceLatch: DeviceRuntimeLatch = "normal";
  let feedingLatch: FeedingRuntimeLatch = "normal";
  const sourceObservationIds: string[] = [];

  for (const row of sorted) {
    const deviceValue = row.deviceStatus ?? row.device_status;
    if (deviceValue !== undefined && deviceValue !== null) {
      const normalized = canonicalDeviceLatch(deviceValue);
      if (normalized) {
        deviceLatch = normalized;
        addSourceId(sourceObservationIds, row);
      }
    }
    const feedingValue = row.feedingResponse ?? row.feeding_response;
    if (feedingValue !== undefined && feedingValue !== null) {
      const normalized = canonicalFeedingLatch(feedingValue);
      if (normalized) {
        feedingLatch = normalized;
        addSourceId(sourceObservationIds, row);
      }
    }
  }

  const reasons: string[] = [];
  if (deviceLatch === "probe_contaminated") reasons.push("probe_contamination");
  if (deviceLatch === "blocked") reasons.push("device_blocked");
  if (feedingLatch === "refusal") reasons.push("feeding_refusal");

  return {
    state: deviceLatch !== "normal"
      ? "blocked"
      : feedingLatch === "refusal"
        ? "manual_hold"
        : "normal",
    reasons,
    sourceObservationIds,
    deviceLatch,
    feedingLatch,
  };
}
