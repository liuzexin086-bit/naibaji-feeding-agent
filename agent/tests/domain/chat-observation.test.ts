import { describe, expect, it } from "vitest";
import { normalizeChatObservation } from "../../src/container/chat-observation.js";

describe("chat observation transport", () => {
  it("preserves explicit none while omission remains absent", () => {
    expect(normalizeChatObservation({ actualPowderGrams: 0 })).toEqual({ actualPowderGrams: 0 });
    expect(normalizeChatObservation({ diarrheaGrade: "none", actualPowderGrams: 0 })).toEqual({
      diarrheaGrade: "none",
      actualPowderGrams: 0,
    });
  });

  it("rejects invalid selected fields and cannot claim application", () => {
    expect(() => normalizeChatObservation({ diarrheaGrade: "invented" })).toThrow("NBJ_AGENT_OBSERVATION_INVALID");
    expect(normalizeChatObservation({ application: "approved" })).toEqual({ actualPowderGrams: null });
    expect(normalizeChatObservation({ diarrheaGrade: "moderate" })).not.toHaveProperty("applied");
  });

  it("keeps legacy numeric-string and empty-string compatibility", () => {
    expect(normalizeChatObservation({ diarrheaGrade: "none", actualPowderGrams: "12.5" })).toEqual({
      diarrheaGrade: "none",
      actualPowderGrams: 12.5,
    });
    expect(normalizeChatObservation({ actualPowderGrams: "" })).toEqual({ actualPowderGrams: null });
  });
});
