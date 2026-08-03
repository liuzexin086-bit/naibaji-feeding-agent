import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { computeDayDecision } from "../decision/core.js";
import type { SqliteLocalStore } from "../local-db/index.js";
import type { LocalBatch } from "../shared/local-store-contract.js";
import {
  authenticateLocalUser,
  clearSessionCookie,
  getSessionToken,
  hashSessionToken,
  requireLocalAdmin,
  requireLocalAuth,
  resolveLocalAuth,
  setSessionCookie,
} from "./local-auth.js";

export const CREEP_VALUES = {
  none: 0,
  low: 10,
  medium: 45,
  high: 80,
  excellent: 130,
} as const;

export const DEFAULT_LOCAL_SOP_VERSION = "2026.08.03-v6-first-day-sop";

export const DEFAULT_SOP_CONFIG: Record<string, unknown> = {
  teachingProgramEnabled: true,
  teachingFirstLocal: "17:00",
  teachingIntervalHours: 3,
  teachingEndLocal: "08:00",
  teachingDirectTotalPowderGrams: 0,
  teachingPowderGramsPerTwenty: 35,
  teachingQuantitySource: "sop",
  quantityAuthorityOrder: ["sop_direct", "sop_indirect", "production_model"],
  modelQuantityFallbackEnabled: true,
  devicePowderPrecisionGrams: 1,
  waterClosedUntilDayAge: 12,
  initialMealCount: 10,
  excludedMealTimes: ["00:00", "12:00"],
  productionProgramStartLocal: "09:00",
};

type JsonObject = Record<string, unknown>;

interface LocalApiEnv {
  AGENT_GATEWAY_SECRET?: string;
  LOCAL_ADMIN_EMAIL?: string;
  LOCAL_ADMIN_PASSWORD?: string;
}

function json(response: ServerResponse, body: unknown, status = 200, extra?: Record<string, string>): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  response.end(JSON.stringify(body));
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message.startsWith("NBJ_")
    ? error.message
    : "NBJ_LOCAL_API_UNAVAILABLE";
}

function sendError(response: ServerResponse, error: unknown): void {
  const code = errorCode(error);
  const status = code === "NBJ_AUTH_REQUIRED" || code === "NBJ_AUTH_INVALID_CREDENTIALS"
    ? 401
    : code === "NBJ_ADMIN_REQUIRED"
      ? 403
      : code === "NBJ_BATCH_STALE"
        ? 409
        : code === "NBJ_BATCH_NOT_FOUND"
          ? 404
          : code === "NBJ_METHOD_NOT_ALLOWED"
            ? 405
            : 400;
  json(response, { code }, status);
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 256 * 1024) throw new Error("NBJ_REQUEST_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("NBJ_JSON_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("NBJ_JSON_INVALID");
  return parsed as JsonObject;
}

function text(value: unknown, field: string, max = 320): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function finite(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`NBJ_${field.toUpperCase()}_INVALID`);
  return value as JsonObject;
}

function addDays(dateLocal: string, days: number): string {
  const date = new Date(`${dateLocal}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function configOf(batch: LocalBatch): JsonObject {
  const config = batch.data.config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? config as JsonObject
    : {};
}

function recordsOf(batch: LocalBatch): JsonObject[] {
  return Array.isArray(batch.data.records)
    ? batch.data.records.filter((row): row is JsonObject => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

type InternalCreepGrade = "none" | "low" | "medium" | "high" | "excellent";
const INTERNAL_CREEP_ORDER: InternalCreepGrade[] = ["none", "low", "medium", "high", "excellent"];

function internalGrade(value: unknown): InternalCreepGrade {
  return INTERNAL_CREEP_ORDER.includes(String(value) as InternalCreepGrade)
    ? value as InternalCreepGrade
    : "none";
}

function sustainedCreepGrade(records: JsonObject[]): InternalCreepGrade {
  const recent = records.slice(-3).map((row) => internalGrade(row.creepGrade));
  if (recent.length < 2) return "none";
  for (let index = INTERNAL_CREEP_ORDER.length - 1; index >= 1; index -= 1) {
    if (recent.filter((grade) => INTERNAL_CREEP_ORDER.indexOf(grade) >= index).length >= 2) {
      return INTERNAL_CREEP_ORDER[index];
    }
  }
  return "none";
}

function modelRecords(records: JsonObject[]): JsonObject[] {
  return records.map((row) => {
    const heads = finite(row.effectiveHeads ?? row.headCount ?? 0, "effectiveHeads", 0);
    const value = finite(row.creepValue ?? CREEP_VALUES[String(row.creepGrade) as keyof typeof CREEP_VALUES] ?? 0, "creepValue");
    return {
      ...row,
      dayAge: finite(row.dayAge ?? 0, "dayAge"),
      headCount: heads,
      totalCreepG: value * heads,
    };
  });
}

function latestGrades(records: JsonObject[]): InternalCreepGrade[] {
  return records.slice(-3).map((row) => internalGrade(row.creepGrade));
}

function batchPublic(batch: LocalBatch): JsonObject {
  const config = configOf(batch);
  const initialHeads = Number(config.initialHeads ?? config.headCount ?? 0);
  const effectiveHeads = Number(config.effectiveHeads ?? config.headCount ?? initialHeads);
  return {
    id: batch.batchId,
    name: String(config.name ?? batch.batchId),
    room: String(config.room ?? ""),
    startAge: Number(config.startAge ?? 3),
    endAge: Number(config.endAge ?? 21),
    initialHeads,
    effectiveHeads,
    currentDayIndex: batch.currentDay,
    currentDayAge: Number(config.startAge ?? 3) + batch.currentDay,
    status: batch.status,
    revision: batch.revision,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

function templateConfig(batch: LocalBatch): { version: string; config: JsonObject } {
  const config = configOf(batch);
  const template = config.sopTemplate;
  if (template && typeof template === "object" && !Array.isArray(template)) {
    const row = template as JsonObject;
    return {
      version: String(row.version ?? DEFAULT_LOCAL_SOP_VERSION),
      config: { ...DEFAULT_SOP_CONFIG, ...(row.config as JsonObject ?? {}) },
    };
  }
  return { version: DEFAULT_LOCAL_SOP_VERSION, config: { ...DEFAULT_SOP_CONFIG } };
}

function firstDaySopQuantity(config: JsonObject): JsonObject {
  const directTotal = finite(
    config.teachingDirectTotalPowderGrams ?? 0,
    "teachingDirectTotalPowderGrams",
    0,
  );
  const perTwenty = finite(
    config.teachingPowderGramsPerTwenty ?? 35,
    "teachingPowderGramsPerTwenty",
    0,
  );
  return {
    ...(directTotal > 0 ? { directTotalPowderGrams: directTotal } : {}),
    ...(perTwenty > 0 ? { powderGramsPerTwentyHeadsPerMeal: perTwenty } : {}),
    mealCount: 6,
  };
}

function decisionFor(batch: LocalBatch, dayIndex = batch.currentDay, revision = batch.revision): JsonObject {
  const config = configOf(batch);
  const template = templateConfig(batch);
  const startAge = integer(config.startAge ?? 3, "startAge", 1, 60);
  const endAge = integer(config.endAge ?? 21, "endAge", startAge, 60);
  const headCount = integer(config.effectiveHeads ?? config.headCount ?? 1, "headCount", 1, 100_000);
  const dayAge = startAge + dayIndex;
  const storedRecords = recordsOf(batch);
  const latest = storedRecords.at(-1);
  const controlStartDay = Number(config.controlStartDay ?? -1);
  const modelInput = {
    startAge,
    endAge,
    startWeight: finite(config.startWeight ?? 2.3, "startWeight", 0.1, 50),
    headCount,
    records: modelRecords(storedRecords),
    controlStartDay,
    dayAge,
    dilutionRatio: String(config.dilutionRatio ?? "水:粉=6:1"),
    devicePowderPrecisionGrams: finite(template.config.devicePowderPrecisionGrams ?? 1, "devicePowderPrecisionGrams", 0.1, 100),
    programStartLocal: "09:00",
  };
  const decisionInput: JsonObject = {
    revision,
    batchId: batch.batchId,
    dateLocal: addDays(String(config.planStartDate ?? batch.createdAt.slice(0, 10)), dayIndex),
    calculationDate: addDays(String(config.planStartDate ?? batch.createdAt.slice(0, 10)), dayIndex),
    sopVersion: template.version,
    modelInput,
    requestedMode: "timed_quantity",
    requestedStatus: "active",
    precisionGrams: modelInput.devicePowderPrecisionGrams,
    creepFeedGradesLast3Days: latestGrades(storedRecords),
    milkControlActive: controlStartDay >= 0 && dayIndex >= controlStartDay,
    diarrheaGrades: latest?.diarrheaGrade
      ? [String(latest.diarrheaGrade)]
      : undefined,
    exceptionSignals: {
      refusal: latest?.feedingResponse === "refusal" || latest?.refusal === true,
      blockage: latest?.deviceStatus === "blocked" || latest?.blockage === true,
      probeContaminated:
        latest?.deviceStatus === "probe_contaminated" ||
        latest?.probeContaminated === true,
    },
  };
  if (dayIndex === 0 && template.config.teachingProgramEnabled !== false) {
    decisionInput.sop = firstDaySopQuantity(template.config);
    decisionInput.teachingProgram = {
      enabled: true,
      firstTeachingLocal: String(template.config.teachingFirstLocal ?? "17:00"),
      intervalHours: finite(template.config.teachingIntervalHours ?? 3, "teachingIntervalHours", 0.5, 12),
      endLocal: String(template.config.teachingEndLocal ?? "08:00"),
    };
  }
  const decision = computeDayDecision(decisionInput as never) as unknown as JsonObject;
  const setting = object(decision.setting, "decision_setting");
  const exceptionActions = Array.isArray(decision.exceptionActions)
    ? decision.exceptionActions
    : [];
  return {
    ...decision,
    setting,
    dayIndex,
    dayAge,
    plannedTotalPowderGrams: Number(setting.dailyPowderGrams ?? 0),
    singlePowderGrams: Number(setting.singlePowderGrams ?? 0),
    mealCount: Number(setting.mealCount ?? 0),
    mealTimes: Array.isArray(setting.timedMeals)
      ? (setting.timedMeals as JsonObject[]).map((meal) => String(meal.timeLocal))
      : [],
    exceptionActions,
    modelVersion: String((decision.evidence as JsonObject | undefined)?.modelVersion ?? "feeding-model+V5-Lite"),
    sopVersion: template.version,
    waterState: dayAge < Number(template.config.waterClosedUntilDayAge ?? 12) ? "closed" : "open",
    planWindow: { startLocal: "09:00", endLocal: "09:00", endDayOffset: 1 },
  };
}

function recordPublic(row: JsonObject, fallback: { dayIndex: number; dayAge: number; heads: number; revision: number }): JsonObject {
  const grade = String(row.creepGrade ?? "none");
  return {
    dayIndex: Number(row.dayIndex ?? fallback.dayIndex),
    dayAge: Number(row.dayAge ?? fallback.dayAge),
    effectiveHeads: Number(row.effectiveHeads ?? row.headCount ?? fallback.heads),
    deviceMode: String(row.deviceMode ?? "timed_quantity"),
    singlePowderGrams: Number(row.singlePowderGrams ?? 0),
    mealCount: Number(row.mealCount ?? 0),
    mealTimes: Array.isArray(row.mealTimes) ? row.mealTimes : [],
    plannedTotalPowderGrams: Number(row.plannedTotalPowderGrams ?? row.planTotalAtCommit ?? 0),
    actualPowderGrams: row.actualPowderGrams == null ? null : Number(row.actualPowderGrams),
    creepGrade: grade,
    creepValue: Number(row.creepValue ?? CREEP_VALUES[grade as keyof typeof CREEP_VALUES] ?? 0),
    diarrheaGrade: String(row.diarrheaGrade ?? "none"),
    waterState: String(row.waterState ?? "closed"),
    exceptionActions: Array.isArray(row.exceptionActions) ? row.exceptionActions : [],
    modelVersion: String(row.modelVersion ?? "feeding-model+V5-Lite"),
    sopVersion: String(row.sopVersion ?? "local-sop-default-v1"),
    revision: Number(row.revision ?? fallback.revision),
    recordedAt: row.recordedAt ?? null,
  };
}

function allRecords(batch: LocalBatch): JsonObject[] {
  const config = configOf(batch);
  const heads = Number(config.effectiveHeads ?? config.headCount ?? 0);
  return recordsOf(batch).map((row) => recordPublic(row, {
    dayIndex: Number(row.dayIndex ?? 0),
    dayAge: Number(row.dayAge ?? Number(config.startAge ?? 3)),
    heads,
    revision: batch.revision,
  }));
}

function parseObservation(body: JsonObject, today: JsonObject, batch: LocalBatch): JsonObject {
  const source = object(body.observation ?? {}, "observation");
  const config = configOf(batch);
  const heads = integer(source.effectiveHeads ?? source.headCount ?? config.effectiveHeads ?? config.headCount ?? 1, "effectiveHeads", 0, 100_000);
  const grade = String(source.creepGrade ?? "none");
  if (!(grade in CREEP_VALUES)) throw new Error("NBJ_CREEP_GRADE_INVALID");
  const diarrhea = String(source.diarrheaGrade ?? "none");
  if (!["none", "mild", "moderate", "severe"].includes(diarrhea)) throw new Error("NBJ_DIARRHEA_GRADE_INVALID");
  const record = {
    ...source,
    dayIndex: Number(today.dayIndex),
    dayAge: Number(today.dayAge),
    effectiveHeads: heads,
    headCount: heads,
    deviceMode: String(source.deviceMode ?? object(today.setting, "today_setting").mode ?? "timed_quantity"),
    singlePowderGrams: Number(source.singlePowderGrams ?? today.singlePowderGrams ?? 0),
    mealCount: Number(source.mealCount ?? today.mealCount ?? 0),
    mealTimes: Array.isArray(source.mealTimes) ? source.mealTimes : today.mealTimes,
    plannedTotalPowderGrams: Number(source.plannedTotalPowderGrams ?? today.plannedTotalPowderGrams ?? 0),
    actualPowderGrams: source.actualPowderGrams == null ? null : finite(source.actualPowderGrams, "actualPowderGrams", 0),
    creepGrade: grade,
    creepValue: CREEP_VALUES[grade as keyof typeof CREEP_VALUES],
    diarrheaGrade: diarrhea,
    waterState: String(source.waterState ?? today.waterState ?? "closed"),
    exceptionActions: Array.isArray(source.exceptionActions) ? source.exceptionActions : today.exceptionActions,
    modelVersion: String(today.modelVersion ?? "feeding-model+V5-Lite"),
    sopVersion: String(today.sopVersion ?? "local-sop-default-v1"),
    recordedAt: new Date().toISOString(),
  };
  return record;
}

export async function handleLocalApi(
  request: IncomingMessage,
  response: ServerResponse,
  store: SqliteLocalStore,
  env: LocalApiEnv = {},
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://container");
  if (!url.pathname.startsWith("/api/")) return false;
  // Agent streaming and provider configuration retain dedicated handlers in
  // server.ts so SSE headers and provider validation stay centralized.
  if (
    url.pathname === "/api/feeding-agent/chat" ||
    url.pathname === "/api/admin/feeding-agent/config"
  ) return false;
  try {
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJson(request);
      const result = authenticateLocalUser(store, body.email, body.password);
      setSessionCookie(response, result.token);
      json(response, { user: result.user });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const auth = resolveLocalAuth(request, store);
      if (!auth) throw new Error("NBJ_AUTH_REQUIRED");
      json(response, { user: auth.user });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const auth = resolveLocalAuth(request, store);
      const token = getSessionToken(request);
      if (auth && token) store.revokeAuthSession(hashSessionToken(token));
      clearSessionCookie(response);
      json(response, { ok: true });
      return true;
    }
    const auth = requireLocalAuth(request, store);

    if (request.method === "GET" && url.pathname === "/api/batches") {
      const batches = store.listBatches(auth.user.id).map(batchPublic);
      json(response, { batches, currentBatchId: batches[0]?.id ?? null });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/batches") {
      const body = await readJson(request);
      const name = text(body.name, "batch_name");
      const room = typeof body.room === "string" ? body.room.trim().slice(0, 160) : "";
      const startAge = integer(body.startAge, "start_age", 1, 60);
      const endAge = integer(body.endAge, "end_age", startAge, 60);
      const headCount = integer(body.headCount, "head_count", 1, 100_000);
      const id = randomUUID();
      const nowDate = new Date().toISOString().slice(0, 10);
      const latestSop = store.listSopTemplates()[0];
      const frozenSop = latestSop
        ? {
            version: latestSop.version,
            config: { ...DEFAULT_SOP_CONFIG, ...latestSop.config },
          }
        : { version: DEFAULT_LOCAL_SOP_VERSION, config: { ...DEFAULT_SOP_CONFIG } };
      const batch = store.createBatch({
        userId: auth.user.id,
        batchId: id,
        data: {
          config: {
            name, room, startAge, endAge,
            initialHeads: headCount, effectiveHeads: headCount,
            headCount, startWeight: finite(body.startWeight ?? 2.3, "start_weight", 0.1, 50),
            planStartDate: nowDate,
            controlStartDay: -1,
            sopTemplate: frozenSop,
          },
          records: [],
          current_day_index: 0,
          control_start_day: -1,
        },
      });
      const session = store.createSession({ id: randomUUID(), userId: auth.user.id, batchId: id, status: "active" });
      const today = decisionFor(batch);
      json(response, { batch: batchPublic(batch), today, records: [], agentSession: session }, 201);
      return true;
    }

    const batchMatch = url.pathname.match(/^\/api\/batches\/([^/]+)(?:\/(.*))?$/);
    if (batchMatch) {
      const batchId = decodeURIComponent(batchMatch[1]);
      const suffix = batchMatch[2] ?? "";
      let batch = store.getBatch(auth.user.id, batchId);
      if (!batch) throw new Error("NBJ_BATCH_NOT_FOUND");
      if (request.method === "GET" && !suffix) {
        const session = store.listSessions(auth.user.id, batchId)[0] ?? store.createSession({ id: randomUUID(), userId: auth.user.id, batchId, status: "active" });
        json(response, { batch: batchPublic(batch), today: decisionFor(batch), records: allRecords(batch), agentSession: session });
        return true;
      }
      if (request.method === "GET" && suffix === "agent/session") {
        const session = store.listSessions(auth.user.id, batchId)[0] ?? store.createSession({ id: randomUUID(), userId: auth.user.id, batchId, status: "active" });
        json(response, { session, messages: store.listMessages(auth.user.id, batchId, session.id, { limit: 1_000 }) });
        return true;
      }
      if (request.method === "POST" && (suffix === "advance" || suffix === "records")) {
        const body = await readJson(request);
        const expectedRevision = integer(body.expectedRevision, "expected_revision", 0, Number.MAX_SAFE_INTEGER);
        const key = text(body.idempotencyKey, "idempotency_key", 160);
        const today = decisionFor(batch);
        const observation = parseObservation(body, today, batch);
        const existingRecords = recordsOf(batch);
        const nextRecords = [...existingRecords.filter((row) => Number(row.dayIndex) !== Number(observation.dayIndex)), observation];
        let controlStartDay = Number(configOf(batch).controlStartDay ?? -1);
        if (controlStartDay < 0 && sustainedCreepGrade(nextRecords) !== "none") {
          controlStartDay = batch.currentDay + 1;
        }
        const nextData: JsonObject = {
          ...batch.data,
          config: { ...configOf(batch), controlStartDay },
          records: nextRecords,
          current_day_index: suffix === "advance" ? batch.currentDay + 1 : batch.currentDay,
          control_start_day: controlStartDay,
        };
        if (suffix === "advance") {
          const nextBatch = {
            ...batch,
            currentDay: batch.currentDay + 1,
            revision: batch.revision + 1,
            data: nextData,
          } as LocalBatch;
          const nextToday = decisionFor(nextBatch, nextBatch.currentDay, nextBatch.revision);
          const session = store.listSessions(auth.user.id, batchId)[0] ?? store.createSession({ id: randomUUID(), userId: auth.user.id, batchId, status: "active" });
          const result = {
            batch: batchPublic(nextBatch),
            today: nextToday,
            records: nextRecords.map((row) => recordPublic(row, { dayIndex: Number(row.dayIndex), dayAge: Number(row.dayAge), heads: Number(row.effectiveHeads), revision: nextBatch.revision })),
            committedRecord: recordPublic(observation, { dayIndex: Number(observation.dayIndex), dayAge: Number(observation.dayAge), heads: Number(observation.effectiveHeads), revision: batch.revision }),
            agentSession: session,
          };
          const committed = store.commitAdvance({
            userId: auth.user.id,
            batchId,
            expectedRevision,
            idempotencyKey: key,
            dateLocal: String(observation.dateLocal ?? today.dateLocal ?? addDays(String(configOf(batch).planStartDate ?? batch.createdAt.slice(0, 10)), batch.currentDay)),
            observedAt: String(observation.recordedAt),
            observation,
            nextDayIndex: batch.currentDay + 1,
            nextData,
            result,
          });
          json(response, committed.result);
          return true;
        }
        const nextBatch = { ...batch, revision: batch.revision + 1, data: nextData } as LocalBatch;
        const result = {
          batch: batchPublic(nextBatch),
          today: decisionFor(nextBatch, nextBatch.currentDay, nextBatch.revision),
          records: nextRecords.map((row) => recordPublic(row, { dayIndex: Number(row.dayIndex), dayAge: Number(row.dayAge), heads: Number(row.effectiveHeads), revision: nextBatch.revision })),
          committedRecord: recordPublic(observation, { dayIndex: Number(observation.dayIndex), dayAge: Number(observation.dayAge), heads: Number(observation.effectiveHeads), revision: batch.revision }),
        };
        const committed = store.commitRecord({ userId: auth.user.id, batchId, expectedRevision, idempotencyKey: key, dateLocal: String(observation.dateLocal ?? today.dateLocal ?? addDays(String(configOf(batch).planStartDate ?? batch.createdAt.slice(0, 10)), batch.currentDay)), observedAt: String(observation.recordedAt), observation, nextData, result });
        json(response, committed.result);
        return true;
      }
    }

    if (url.pathname === "/api/admin/sop/templates") {
      if (request.method === "GET") {
        requireLocalAdmin(request, store);
        json(response, { templates: store.listSopTemplates() });
        return true;
      }
      if (request.method === "POST") {
        const admin = requireLocalAdmin(request, store);
        const body = await readJson(request);
        const sourceId = body.copyFromId == null ? null : text(body.copyFromId, "copy_from_id", 128);
        const source = sourceId ? store.listSopTemplates().find((row) => row.id === sourceId) : null;
        if (sourceId && !source) throw new Error("NBJ_SOP_TEMPLATE_NOT_FOUND");
        const config = { ...(source?.config ?? {}), ...object(body.config ?? {}, "config") };
        const template = store.createSopTemplate({ version: text(body.version, "version", 160), name: text(body.name, "name", 200), config, createdBy: admin.user.id, sourceTemplateId: sourceId });
        json(response, { template }, 201);
        return true;
      }
      throw new Error("NBJ_METHOD_NOT_ALLOWED");
    }
    throw new Error("NBJ_LOCAL_API_ROUTE_NOT_FOUND");
  } catch (error) {
    sendError(response, error);
    return true;
  }
}
