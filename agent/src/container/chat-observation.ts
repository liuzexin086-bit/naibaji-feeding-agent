import { parseObservation, type DiarrheaGrade } from "../domain/observation.js";

export interface ChatObservation {
  diarrheaGrade?: DiarrheaGrade;
  actualPowderGrams: number | null;
}

export type ChatObservationBoundaryResult =
  | { readonly ok: true; readonly observation?: ChatObservation }
  | { readonly ok: false; readonly code: "NBJ_AGENT_OBSERVATION_INVALID" };

/**
 * Translate only the fields owned by the chat contract. The UI sends a richer
 * observation payload to other endpoints; those metadata fields are not chat
 * observation fields and must not make this boundary reject a valid request.
 */
export function normalizeChatObservation(raw: unknown): ChatObservation | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("DOMAIN_OBSERVATION_INVALID");
    }
    const source = raw as Record<string, unknown>;
    const hasDiarrhea = Object.prototype.hasOwnProperty.call(source, "diarrheaGrade");
    const actualRaw = source.actualPowderGrams;
    let actualPowderGrams: number | null;
    if (actualRaw === undefined || actualRaw === null || actualRaw === "") {
      actualPowderGrams = null;
    } else if (typeof actualRaw === "number" || typeof actualRaw === "string") {
      actualPowderGrams = Number(actualRaw);
      if (!Number.isFinite(actualPowderGrams) || actualPowderGrams < 0) {
        throw new Error("DOMAIN_OBSERVATION_INVALID");
      }
    } else {
      throw new Error("DOMAIN_OBSERVATION_INVALID");
    }
    const observation = parseObservation({
      ...(hasDiarrhea ? { diarrheaGrade: source.diarrheaGrade } : {}),
      actualPowderGrams,
    });
    const diarrheaGrade = observation.diarrheaGrade.kind === "observed"
      ? observation.diarrheaGrade.value
      : undefined;
    return {
      ...(diarrheaGrade === undefined ? {} : { diarrheaGrade }),
      actualPowderGrams: observation.actualPowderGrams,
    };
  } catch {
    throw new Error("NBJ_AGENT_OBSERVATION_INVALID");
  }
}

/** Pure boundary seam used by the HTTP route and its transport regression test. */
export function handleChatObservation(raw: unknown): ChatObservationBoundaryResult {
  try {
    return { ok: true, observation: normalizeChatObservation(raw) };
  } catch {
    return { ok: false, code: "NBJ_AGENT_OBSERVATION_INVALID" };
  }
}
