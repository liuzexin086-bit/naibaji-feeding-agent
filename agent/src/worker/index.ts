import { Container } from "@cloudflare/containers";
import {
  computeProductionPlan,
  getModelDerivedMealAmount,
} from "../model/production-model.js";
import {
  DEFAULT_SOP_TEMPLATE,
  generateAgeTasks,
  generateCustomTasks,
  generateMaintenanceTasks,
  generateTeachingTasks,
  generateWaterTasks,
  startSopRun,
} from "../sop/engine.js";
import type { SopTemplateSnapshot } from "../sop/types.js";
import {
  SupabaseRestError,
  bearerToken,
  supabaseInsert,
  supabaseRest,
  type SupabaseRuntime,
} from "../shared/supabase-rest.js";
import { verifySupabaseJwt } from "./auth.js";

interface Env extends SupabaseRuntime {
  ASSETS: Fetcher;
  FEEDING_AGENT_CONTAINER: DurableObjectNamespace<FeedingAgentContainer>;
  SUPABASE_PUBLISHABLE_KEY: string;
  AGENT_GATEWAY_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AGENT_ENABLED: string;
  SOP_ENABLED: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  LOCAL_AGENT_URL?: string;
}

interface AuthContext {
  token: string;
  userId: string;
}

export class FeedingAgentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const supabaseHost = new URL(env.SUPABASE_URL).hostname;
    this.allowedHosts = [supabaseHost, "api.anthropic.com", "api.openai.com"];
    this.envVars = {
      NODE_ENV: "production",
      PORT: "8080",
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
      AGENT_GATEWAY_SECRET: env.AGENT_GATEWAY_SECRET,
      LLM_PROVIDER: env.LLM_PROVIDER,
      LLM_MODEL: env.LLM_MODEL,
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
    };
  }
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("NBJ_JSON_REQUIRED");
  return (await request.json()) as T;
}

async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  const token = bearerToken(request);
  if (!token) throw new Error("NBJ_AUTH_REQUIRED");
  const payload = await verifySupabaseJwt(env, token);
  return { token, userId: String(payload.sub) };
}

async function ensureAdmin(env: Env, auth: AuthContext): Promise<void> {
  const isAdmin = await supabaseRest<boolean>(
    env,
    auth.token,
    "/rest/v1/rpc/is_admin",
    { method: "POST", body: "{}" },
  );
  if (isAdmin !== true) throw new Error("NBJ_ADMIN_REQUIRED");
}

function requireFeature(value: string, code: string): void {
  if (value !== "true") throw new Error(code);
}

function effectiveRunPhase(run: Record<string, unknown>, now: number): string {
  const storedPhase = String(run.phase || "adaptation");
  if (
    !["adaptation", "first_teaching", "teaching_loop", "production_feeding"]
      .includes(storedPhase) ||
    run.status !== "active"
  ) {
    return storedPhase;
  }
  const firstTeaching = Date.parse(String(run.first_teaching_at));
  const admitted = Date.parse(String(run.admitted_at));
  const template = (run.template_snapshot ?? {}) as Record<string, unknown>;
  const offsetMinutes = Number(template.utcOffsetMinutes ?? 480);
  const endDayOffset = Math.max(
    0,
    Math.floor(Number(template.teachingProgramEndDayOffset ?? 1)),
  );
  const endMatch = String(template.teachingProgramEndLocal ?? "08:00")
    .match(/^(\d{2}):(\d{2})$/);
  const endMinutes = endMatch ? Number(endMatch[1]) * 60 + Number(endMatch[2]) : 480;
  const localAdmission = new Date(admitted + offsetMinutes * 60_000);
  const localDate = localAdmission.toISOString().slice(0, 10);
  const teachingEnd =
    Date.parse(`${localDate}T00:00:00.000Z`) +
    endDayOffset * 86_400_000 +
    endMinutes * 60_000 -
    offsetMinutes * 60_000;
  if (Number.isFinite(firstTeaching) && now < firstTeaching) return "adaptation";
  if (Number.isFinite(teachingEnd) && now < teachingEnd) {
    return "teaching_loop";
  }
  return "production_feeding";
}

async function getTodayTimeline(
  env: Env,
  auth: AuthContext,
  batchId: string,
): Promise<Response> {
  const runs = await supabaseRest<Array<Record<string, unknown>>>(
    env,
    auth.token,
    `/rest/v1/feeding_sop_runs?batch_id=eq.${encodeURIComponent(batchId)}&status=in.(active,paused)&select=*&order=started_at.desc&limit=1`,
  );
  const run = runs[0];
  if (!run) return json({ run: null, tasks: [], laggards: [], nextTask: null });
  const runId = String(run.id);
  const [tasks, laggards] = await Promise.all([
    supabaseRest<Array<Record<string, unknown>>>(
      env,
      auth.token,
      `/rest/v1/feeding_sop_events?run_id=eq.${encodeURIComponent(runId)}&select=*&order=scheduled_at.asc,sequence.asc`,
    ),
    supabaseRest<Array<Record<string, unknown>>>(
      env,
      auth.token,
      `/rest/v1/feeding_laggard_cases?run_id=eq.${encodeURIComponent(runId)}&select=*&order=observed_at.asc`,
    ),
  ]);
  const now = Date.now();
  const responseRun = { ...run, phase: effectiveRunPhase(run, now) };
  const normalized: Array<Record<string, unknown> & { status?: unknown }> = tasks.map((task) => ({
    ...task,
    display_status:
      task.status === "pending" && Date.parse(String(task.scheduled_at)) < now
        ? "overdue"
        : task.status,
  }));
  return json({
    run: responseRun,
    tasks: normalized,
    laggards,
    nextTask: normalized.find((task) => task.status === "pending") ?? null,
  });
}

async function startRun(
  request: Request,
  env: Env,
  auth: AuthContext,
  batchId: string,
): Promise<Response> {
  requireFeature(env.SOP_ENABLED, "NBJ_SOP_DISABLED");
  const body = await readJson<{
    templateId: string;
    admittedAt: string;
    activeHeadCount: number;
    dilutionRatio: string;
    startAge?: number;
    endAge?: number;
    idempotencyKey?: string;
  }>(request);
  if (!body.templateId || !body.admittedAt || !body.dilutionRatio) {
    throw new Error("NBJ_SOP_START_FIELDS_REQUIRED");
  }
  const [templates, batches] = await Promise.all([
    supabaseRest<
      Array<{ id: string; version: string; config: Partial<SopTemplateSnapshot> }>
    >(
      env,
      auth.token,
      `/rest/v1/feeding_sop_templates?id=eq.${encodeURIComponent(body.templateId)}&select=id,version,config&limit=1`,
    ),
    supabaseRest<Array<{
      config?: Record<string, unknown>;
      records?: Array<Record<string, unknown>>;
      control_start_day?: number;
    }>>(
      env,
      auth.token,
      `/rest/v1/batches?id=eq.${encodeURIComponent(batchId)}&select=config,records,control_start_day&limit=1`,
    ),
  ]);
  const row = templates[0];
  if (!row) throw new Error("NBJ_SOP_TEMPLATE_NOT_FOUND");
  const batch = batches[0];
  if (!batch) throw new Error("NBJ_BATCH_NOT_FOUND");
  const template = {
    ...DEFAULT_SOP_TEMPLATE,
    ...row.config,
    version: row.version,
  } as SopTemplateSnapshot;
  const batchConfig = batch.config ?? {};
  const startAge = Number(batchConfig.startAge ?? body.startAge ?? 3);
  const endAge = Number(batchConfig.endAge ?? body.endAge ?? 21);
  const productionPlan = computeProductionPlan({
    startAge,
    endAge,
    startWeight: Number(batchConfig.startWeight ?? 2.3),
    headCount: body.activeHeadCount,
    records: batch.records ?? [],
    controlStartDay: Number(batch.control_start_day ?? -1),
    dayAge: startAge,
    devicePowderPrecisionGrams: template.devicePowderPrecisionGrams,
    programStartLocal: template.productionProgramStartLocal ?? "00:00",
  });
  const modelMeal = getModelDerivedMealAmount(productionPlan);
  const id = crypto.randomUUID();
  const started = startSopRun({
    id,
    batchId,
    userId: auth.userId,
    admittedAt: body.admittedAt,
    activeHeadCount: body.activeHeadCount,
    dilutionRatio: body.dilutionRatio,
    modelMeal,
    template,
  });
  const runRow = {
    id: started.run.id,
    batch_id: batchId,
    template_id: row.id,
    template_version: started.run.template.version,
    template_snapshot: started.run.template,
    model_version: started.run.modelVersion,
    model_hash: started.run.modelHash,
    timezone: started.run.template.timezone,
    dilution_ratio: started.run.dilutionRatio,
    phase: started.run.phase,
    revision: started.run.revision,
    status: started.run.status,
    active_head_count: started.run.activeHeadCount,
    admitted_at: started.run.admittedAt,
    first_teaching_at: started.run.firstTeachingAt,
    started_at: started.run.startedAt,
  };
  const teachingThrough = new Date(
    new Date(started.run.admittedAt).getTime() +
      started.run.template.teachingLatestDay * 24 * 60 * 60 * 1000,
  ).toISOString();
  const scheduledTasks = [
    ...started.initialTasks,
    ...generateTeachingTasks(started.run, teachingThrough, modelMeal),
    ...generateWaterTasks(
      started.run,
      startAge,
      started.run.admittedAt,
      {
        feedingResponse: "active",
        abdomenState: "full",
        diarrhea: "none",
        deviceStatus: "ok",
      },
    ).tasks,
  ];
  const totalDays = Math.max(1, endAge - startAge + 1);
  for (let day = 1; day <= totalDays; day += 1) {
    const dayStart = new Date(
      new Date(started.run.admittedAt).getTime() + (day - 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    scheduledTasks.push(
      ...generateAgeTasks(started.run, startAge + day - 1, dayStart),
      ...generateMaintenanceTasks(started.run, day, dayStart, day === totalDays),
    );
  }
  scheduledTasks.push(
    ...generateCustomTasks(started.run, startAge),
  );
  scheduledTasks.sort((a, b) => {
    const byTime = Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt);
    if (byTime !== 0) return byTime;
    const priority: Record<string, number> = {
      water_close: 1,
      water_check: 2,
      teaching_meal: 3,
      gentle_movement: 4,
      water_restore: 5,
    };
    return (priority[a.kind] ?? 10) - (priority[b.kind] ?? 10);
  });
  const events = scheduledTasks.map((task, index) => ({
    id: crypto.randomUUID(),
    user_id: auth.userId,
    run_id: started.run.id,
    batch_id: batchId,
    task_kind: task.kind,
    title: task.title,
    scheduled_at: task.scheduledAt,
    status: task.status,
    plan_source: task.planSource,
    sequence: index + 1,
    planned_values: {
      ...(task.numericPlan ?? {}),
      ...(task.metadata ?? {}),
      requiresConfirmation: task.requiresConfirmation,
    },
    idempotency_key: `${body.idempotencyKey ?? started.run.id}:${index + 1}`,
    run_revision: 0,
  }));
  const inserted = await supabaseRest<{
    run: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
  }>(
    env,
    auth.token,
    "/rest/v1/rpc/start_feeding_sop_run",
    {
      method: "POST",
      body: JSON.stringify({ p_run: runRow, p_events: events }),
    },
  );
  return json(
    {
      run: inserted.run,
      tasks: inserted.events,
      deviations: started.deviations,
    },
    201,
  );
}

async function completeTask(
  request: Request,
  env: Env,
  auth: AuthContext,
  eventId: string,
): Promise<Response> {
  const body = await readJson<{
    expectedRevision: number;
    actualCompletedAt?: string;
    actualValues?: Record<string, unknown>;
    idempotencyKey: string;
  }>(request);
  const result = await supabaseRest<Record<string, unknown>>(
    env,
    auth.token,
    "/rest/v1/rpc/complete_feeding_sop_task",
    {
      method: "POST",
      body: JSON.stringify({
        p_event_id: eventId,
        p_expected_revision: body.expectedRevision,
        p_actual_completed_at: body.actualCompletedAt ?? new Date().toISOString(),
        p_actual_values: body.actualValues ?? {},
        p_idempotency_key: body.idempotencyKey,
      }),
    },
  );
  return json(result);
}

async function recordException(
  request: Request,
  env: Env,
  auth: AuthContext,
  eventId: string,
): Promise<Response> {
  const body = await readJson<{
    expectedRevision: number;
    exceptionType: string;
    note: string;
    actualValues?: Record<string, unknown>;
  }>(request);
  const result = await supabaseRest<Record<string, unknown>>(
    env,
    auth.token,
    "/rest/v1/rpc/record_feeding_sop_exception",
    {
      method: "POST",
      body: JSON.stringify({
        p_event_id: eventId,
        p_expected_revision: body.expectedRevision,
        p_exception_type: body.exceptionType,
        p_exception_note: body.note,
        p_actual_values: body.actualValues ?? {},
      }),
    },
  );
  return json(result);
}

async function createLaggard(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson<Record<string, unknown> & {
    action?: "create" | "supplement" | "evaluate";
    caseId?: string;
    expectedCount?: number;
    outcome?: "keep" | "return_to_sow";
  }>(request);
  if (body.action === "supplement") {
    const result = await supabaseRest<Record<string, unknown>>(
      env,
      auth.token,
      "/rest/v1/rpc/record_feeding_laggard_supplement",
      {
        method: "POST",
        body: JSON.stringify({
          p_case_id: body.caseId,
          p_expected_count: body.expectedCount,
        }),
      },
    );
    return json(result);
  }
  if (body.action === "evaluate") {
    const result = await supabaseRest<Record<string, unknown>>(
      env,
      auth.token,
      "/rest/v1/rpc/evaluate_feeding_laggard_case",
      {
        method: "POST",
        body: JSON.stringify({
          p_case_id: body.caseId,
          p_outcome: body.outcome,
        }),
      },
    );
    return json(result);
  }
  const result = await supabaseInsert<Array<Record<string, unknown>>>(
    env,
    auth.token,
    "feeding_laggard_cases",
    {
      id: body.id ?? crypto.randomUUID(),
      user_id: auth.userId,
      run_id: body.run_id,
      batch_id: body.batch_id,
      pig_tag: body.pig_tag,
      observed_at: body.observed_at ?? new Date().toISOString(),
      not_approaching_trough: body.not_approaching_trough === true,
      hollow_abdomen: body.hollow_abdomen === true,
      feeding_response: body.feeding_response ?? null,
      abdomen_state: body.abdomen_state ?? null,
      supplement_count: 0,
      status: "open",
      operator_id: auth.userId,
    },
  );
  return json(result[0], 201);
}

async function reviewDecision(
  request: Request,
  env: Env,
  auth: AuthContext,
  decisionId: string,
  action: "approve" | "reject",
): Promise<Response> {
  const body = await readJson<{ expectedRevision: number; note?: string }>(request);
  const result = await supabaseRest<Record<string, unknown>>(
    env,
    auth.token,
    "/rest/v1/rpc/review_feeding_agent_decision",
    {
      method: "POST",
      body: JSON.stringify({
        p_decision_id: decisionId,
        p_expected_revision: body.expectedRevision,
        p_action: action,
        p_review_note: body.note ?? null,
      }),
    },
  );
  return json(result);
}

async function forwardChat(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (!env.LOCAL_AGENT_URL) {
    requireFeature(env.AGENT_ENABLED, "NBJ_AGENT_DISABLED");
  }
  const headers = new Headers(request.headers);
  headers.set("x-agent-gateway-secret", env.AGENT_GATEWAY_SECRET);
  headers.set("x-auth-user", auth.userId);
  if (env.LOCAL_AGENT_URL) {
    const target = new URL("/api/feeding-agent/chat", env.LOCAL_AGENT_URL);
    return fetch(target, {
      method: "POST",
      headers,
      body: await request.arrayBuffer(),
    });
  }
  const forwarded = new Request(request, { headers });
  const container = env.FEEDING_AGENT_CONTAINER.getByName(auth.userId);
  return container.fetch(forwarded);
}

async function forwardAdminAgentConfig(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (!env.LOCAL_AGENT_URL) {
    throw new Error("NBJ_AGENT_CONFIG_MANAGED_BY_DEPLOYMENT");
  }
  const headers = new Headers(request.headers);
  headers.set("x-agent-gateway-secret", env.AGENT_GATEWAY_SECRET);
  headers.set("x-agent-admin", "true");
  headers.set("x-auth-user", auth.userId);
  const target = new URL("/internal/admin/feeding-agent/config", env.LOCAL_AGENT_URL);
  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : await request.arrayBuffer(),
  });
}

function normalizeError(error: unknown): Response {
  console.error(JSON.stringify({
    event: "feeding_agent_error",
    message: error instanceof Error ? error.message : String(error),
  }));
  if (error instanceof SupabaseRestError) {
    const bodyText = JSON.stringify(error.body);
    const code = bodyText.match(/NBJ_[A-Z0-9_]+/)?.[0] ?? "NBJ_SUPABASE_ERROR";
    const stale = code === "NBJ_AGENT_STALE";
    return json(
      { code, detail: error.body },
      stale ? 409 : error.status,
    );
  }
  const message = error instanceof Error ? error.message : "NBJ_INTERNAL_ERROR";
  const auth = message.startsWith("NBJ_AUTH");
  const forbidden = message === "NBJ_ADMIN_REQUIRED";
  const disabled = message.endsWith("_DISABLED");
  const notFound = message.endsWith("_NOT_FOUND");
  const managed = message === "NBJ_AGENT_CONFIG_MANAGED_BY_DEPLOYMENT";
  return json(
    { code: message.startsWith("NBJ_") ? message : "NBJ_INTERNAL_ERROR" },
    auth ? 401 : forbidden ? 403 : disabled || managed ? 503 : notFound ? 404 : 400,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      const response = await env.ASSETS.fetch(request);
      if (
        url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname === "/admin" ||
        url.pathname === "/admin.html" ||
        url.pathname === "/admin.js"
      ) {
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store, max-age=0");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return response;
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    try {
      const auth = await authenticate(request, env);
      const timeline = url.pathname.match(/^\/api\/batches\/([^/]+)\/sop\/today$/);
      if (request.method === "GET" && timeline) {
        return getTodayTimeline(env, auth, decodeURIComponent(timeline[1]));
      }
      const start = url.pathname.match(/^\/api\/batches\/([^/]+)\/sop\/start$/);
      if (request.method === "POST" && start) {
        return startRun(request, env, auth, decodeURIComponent(start[1]));
      }
      const complete = url.pathname.match(/^\/api\/sop\/tasks\/([^/]+)\/complete$/);
      if (request.method === "POST" && complete) {
        return completeTask(request, env, auth, complete[1]);
      }
      const exception = url.pathname.match(/^\/api\/sop\/tasks\/([^/]+)\/exception$/);
      if (request.method === "POST" && exception) {
        return recordException(request, env, auth, exception[1]);
      }
      if (request.method === "POST" && url.pathname === "/api/laggard-cases") {
        return createLaggard(request, env, auth);
      }
      const decision = url.pathname.match(
        /^\/api\/feeding-agent\/decisions\/([^/]+)\/(approve|reject)$/,
      );
      if (request.method === "POST" && decision) {
        return reviewDecision(
          request,
          env,
          auth,
          decision[1],
          decision[2] as "approve" | "reject",
        );
      }
      if (request.method === "POST" && url.pathname === "/api/feeding-agent/chat") {
        return forwardChat(request, env, auth);
      }
      const isAgentConfig =
        url.pathname === "/api/admin/feeding-agent/config" &&
        (request.method === "GET" || request.method === "PUT");
      const isAgentConfigValidation =
        url.pathname === "/api/admin/feeding-agent/config/validate" &&
        request.method === "POST";
      if (isAgentConfig || isAgentConfigValidation) {
        await ensureAdmin(env, auth);
        return forwardAdminAgentConfig(request, env, auth);
      }
      return json({ code: "NBJ_API_NOT_FOUND" }, 404);
    } catch (error) {
      return normalizeError(error);
    }
  },
} satisfies ExportedHandler<Env>;
