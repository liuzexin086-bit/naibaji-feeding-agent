import { assertNonOverlappingBusinessDayWindows } from "./business-day.js";
import type { FreeFeedingSlot, FreeFeedingSlotNumber } from "../shared/local-store-contract.js";

export const FREE_FEEDING_SLOT_COUNT = 8;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function fail(code: string): never {
  throw new Error(`NBJ_${code}`);
}

function defaultSlot(slot: FreeFeedingSlotNumber): FreeFeedingSlot {
  return {
    slot,
    enabled: slot === 1,
    label: `自由采食时段 ${slot}`,
    startLocal: slot === 1 ? "00:00" : "09:00",
    endLocal: slot === 1 ? "23:59" : "10:00",
  };
}

export function defaultFreeFeedingSlots(): FreeFeedingSlot[] {
  return Array.from({ length: FREE_FEEDING_SLOT_COUNT }, (_, index) =>
    defaultSlot((index + 1) as FreeFeedingSlotNumber));
}

/**
 * Canonicalizes the persisted editor payload. Disabled rows remain immutable
 * snapshot data, but only enabled rows participate in the device program.
 */
export function normalizeFreeFeedingSlots(value: unknown): FreeFeedingSlot[] {
  if (!Array.isArray(value) || value.length !== FREE_FEEDING_SLOT_COUNT) {
    fail("FREE_FEEDING_SLOTS_INVALID");
  }
  const slots = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("FREE_FEEDING_SLOTS_INVALID");
    const row = entry as Record<string, unknown>;
    const slot = index + 1;
    if (row.slot !== slot || typeof row.enabled !== "boolean" ||
        typeof row.startLocal !== "string" || !TIME_PATTERN.test(row.startLocal) ||
        typeof row.endLocal !== "string" || !TIME_PATTERN.test(row.endLocal)) {
      fail("FREE_FEEDING_SLOTS_INVALID");
    }
    if (row.label !== undefined && (typeof row.label !== "string" || row.label.trim().length > 80)) {
      fail("FREE_FEEDING_SLOTS_INVALID");
    }
    return {
      slot: slot as FreeFeedingSlotNumber,
      enabled: row.enabled,
      ...(typeof row.label === "string" && row.label.trim() ? { label: row.label.trim() } : {}),
      startLocal: row.startLocal,
      endLocal: row.endLocal,
    };
  });
  const enabled = slots.filter((slot) => slot.enabled);
  if (enabled.length < 1) fail("FREE_FEEDING_SLOTS_ENABLED_REQUIRED");
  try {
    assertNonOverlappingBusinessDayWindows(enabled);
  } catch (error) {
    const code = error instanceof Error ? error.message : "NBJ_DECISION_FREE_WINDOWS_INVALID";
    if (code === "NBJ_DECISION_FREE_WINDOW_ZERO_DURATION") fail("FREE_FEEDING_SLOT_ZERO_DURATION");
    if (code === "NBJ_DECISION_FREE_WINDOWS_OVERLAP") fail("FREE_FEEDING_SLOTS_OVERLAP");
    throw error;
  }
  return slots;
}

export function enabledFreeFeedingWindows(slots: FreeFeedingSlot[]) {
  return slots.filter((slot) => slot.enabled).map(({ startLocal, endLocal }) => ({ startLocal, endLocal }));
}
