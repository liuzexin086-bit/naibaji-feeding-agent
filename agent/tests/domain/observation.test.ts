import { describe, expect, it } from "vitest";
import { isObservation, notObserved, observed, observationValue, parseObservation } from "../../src/domain/observation.js";

describe("domain observation", () => {
  it("distinguishes omission from explicit diarrhea none", () => {
    const omitted = parseObservation({ actualPowderGrams: null });
    const none = parseObservation({ diarrheaGrade: "none", actualPowderGrams: 0 });
    expect(omitted.diarrheaGrade).toEqual(notObserved());
    expect(none.diarrheaGrade).toEqual(observed("none"));
    expect(observationValue(none.diarrheaGrade)).toBe("none");
  });

  it("fails closed for invalid values", () => {
    expect(() => parseObservation({ diarrheaGrade: "unknown" })).toThrow("DOMAIN_OBSERVATION_INVALID");
    expect(() => parseObservation({ actualPowderGrams: -1 })).toThrow("DOMAIN_OBSERVATION_INVALID");
  });

  it("recognizes its own canonical tagged output", () => {
    const parsed = parseObservation({ diarrheaGrade: "none", actualPowderGrams: 0 });
    expect(isObservation(parsed)).toBe(true);
    expect(isObservation({ ...parsed, diarrheaGrade: { kind: "observed", value: "unknown" } })).toBe(false);
    expect(isObservation({ ...parsed, diarrheaGrade: { kind: "not_observed", value: "none" } })).toBe(false);
  });
});
