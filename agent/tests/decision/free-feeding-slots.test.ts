import { describe, expect, it } from "vitest";
import {
  defaultFreeFeedingSlots,
  enabledFreeFeedingWindows,
  normalizeFreeFeedingSlots,
} from "../../src/decision/free-feeding-slots.js";

describe("eight-slot free-feeding configuration", () => {
  it("retains every numbered slot but exposes only enabled windows to the core", () => {
    const slots = defaultFreeFeedingSlots();
    slots[0] = { ...slots[0]!, startLocal: "23:00", endLocal: "02:00" };
    slots[1] = { ...slots[1]!, enabled: true, startLocal: "03:00", endLocal: "05:00" };
    const normalized = normalizeFreeFeedingSlots(slots);
    expect(normalized).toHaveLength(8);
    expect(normalized.map((slot) => slot.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(enabledFreeFeedingWindows(normalized)).toEqual([
      { startLocal: "23:00", endLocal: "02:00" },
      { startLocal: "03:00", endLocal: "05:00" },
    ]);
  });

  it("rejects missing rows, overlapping enabled rows, and zero-length rows", () => {
    expect(() => normalizeFreeFeedingSlots(defaultFreeFeedingSlots().slice(0, 7)))
      .toThrow("NBJ_FREE_FEEDING_SLOTS_INVALID");

    const overlap = defaultFreeFeedingSlots();
    overlap[0] = { ...overlap[0]!, startLocal: "23:00", endLocal: "02:00" };
    overlap[1] = { ...overlap[1]!, enabled: true, startLocal: "01:00", endLocal: "03:00" };
    expect(() => normalizeFreeFeedingSlots(overlap)).toThrow("NBJ_FREE_FEEDING_SLOTS_OVERLAP");

    const zero = defaultFreeFeedingSlots();
    zero[0] = { ...zero[0]!, startLocal: "09:00", endLocal: "09:00" };
    expect(() => normalizeFreeFeedingSlots(zero)).toThrow("NBJ_FREE_FEEDING_SLOT_ZERO_DURATION");
  });
});
