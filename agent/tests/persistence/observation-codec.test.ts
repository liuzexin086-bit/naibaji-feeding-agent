import { describe, expect, it } from "vitest";
import {
  domainObservationToLegacyPayload,
  legacyObservationToDomain,
} from "../../src/persistence/observation-codec.js";
import { parseObservation } from "../../src/domain/observation.js";

describe("observation persistence codec", () => {
  it("encodes omission as omission and explicit none as none", () => {
    const omitted = domainObservationToLegacyPayload(parseObservation({ actualPowderGrams: null }));
    const explicitNone = domainObservationToLegacyPayload(parseObservation({
      diarrheaGrade: "none",
      actualPowderGrams: null,
    }));
    expect(Object.prototype.hasOwnProperty.call(omitted, "diarrheaGrade")).toBe(false);
    expect(explicitNone.diarrheaGrade).toBe("none");
    expect(legacyObservationToDomain(omitted).diarrheaGrade).toEqual({ kind: "not_observed" });
    expect(legacyObservationToDomain(explicitNone).diarrheaGrade).toEqual({
      kind: "observed",
      value: "none",
    });
  });

  it("round-trips mild and preserves powder null versus zero", () => {
    const mild = parseObservation({ diarrheaGrade: "mild", actualPowderGrams: 0 });
    const missingPowder = parseObservation({ diarrheaGrade: "mild", actualPowderGrams: null });
    expect(legacyObservationToDomain(domainObservationToLegacyPayload(mild))).toEqual(mild);
    expect(legacyObservationToDomain(domainObservationToLegacyPayload(missingPowder))).toEqual(missingPowder);
  });

  it("ignores non-authoritative legacy metadata but fails closed on owned values", () => {
    expect(legacyObservationToDomain({
      dayIndex: 2,
      effectiveHeads: 20,
      diarrheaGrade: "moderate",
      actualPowderGrams: 12,
    }).diarrheaGrade).toEqual({ kind: "observed", value: "moderate" });
    expect(() => legacyObservationToDomain({ diarrheaGrade: "invented" }))
      .toThrow("PERSISTENCE_OBSERVATION_INVALID");
    expect(() => legacyObservationToDomain({ actualPowderGrams: "not-a-number" }))
      .toThrow("PERSISTENCE_OBSERVATION_INVALID");
  });
});
