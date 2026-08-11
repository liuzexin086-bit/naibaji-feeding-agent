import { describe, expect, it } from "vitest";
import { hasActiveOrFutureBusinessDayWindow } from "../../src/decision/business-day.js";

describe("free-feeding business-day window availability", () => {
  it("treats active and future windows as deliverable within the 09:00 business day", () => {
    expect(hasActiveOrFutureBusinessDayWindow(
      [{ startLocal: "09:00", endLocal: "17:00" }],
      "13:00",
    )).toBe(true);
    expect(hasActiveOrFutureBusinessDayWindow(
      [{ startLocal: "23:00", endLocal: "02:00" }],
      "00:30",
    )).toBe(true);
  });

  it("does not treat a completed cross-midnight window as future", () => {
    expect(hasActiveOrFutureBusinessDayWindow(
      [{ startLocal: "23:00", endLocal: "02:00" }],
      "03:00",
    )).toBe(false);
    expect(hasActiveOrFutureBusinessDayWindow(
      [
        { startLocal: "23:00", endLocal: "02:00" },
        { startLocal: "04:00", endLocal: "05:00" },
      ],
      "03:30",
    )).toBe(true);
  });
});
