import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(import.meta.dirname, "../../supabase-setup.sql"), "utf8");

const businessTables = [
  "feeding_sop_templates",
  "feeding_sop_runs",
  "feeding_sop_events",
  "feeding_laggard_cases",
  "feeding_agent_sessions",
  "feeding_agent_messages",
  "feeding_agent_decisions",
];

describe("Supabase feeding-agent contract", () => {
  it.each(businessTables)("enables RLS and revokes anon on %s", (table) => {
    expect(sql).toContain(`alter table public.${table} enable row level security`);
    expect(sql).toMatch(
      new RegExp(
        `revoke all on table[\\s\\S]*?public\\.${table}[\\s\\S]*?from anon`,
        "i",
      ),
    );
  });

  it("uses auth.uid ownership checks and explicit authenticated grants", () => {
    expect(sql).toContain("(select auth.uid()) = user_id");
    expect(sql).toContain("to authenticated");
    expect(sql).not.toContain("service_role");
  });

  it("keeps templates immutable through grants", () => {
    expect(sql).toContain(
      "grant select, insert on table public.feeding_sop_templates to authenticated",
    );
    expect(sql).not.toContain(
      "grant select, insert, update on table public.feeding_sop_templates",
    );
    expect(sql).toContain("enforce_feeding_sop_template_immutability");
    expect(sql).toContain("old.status = 'published' and new.status = 'retired'");
  });

  it("publishes global SOP versions through an admin-only RPC", () => {
    expect(sql).toContain("create or replace function public.admin_publish_feeding_sop_template");
    expect(sql).toContain("if not public.is_admin()");
    expect(sql).toContain("feeding_sop_templates_global_version_idx");
    expect(sql).toContain("status = 'published' or (select public.is_admin())");
  });

  it("freezes the database template rather than trusting a client snapshot", () => {
    const start = sql.indexOf("create or replace function public.start_feeding_sop_run")
    const end = sql.indexOf("-- 原子完成任务", start)
    const body = sql.slice(start, end)
    expect(body).toContain("select * into v_template")
    expect(body).toContain("v_template_snapshot := v_template.config")
    expect(body).not.toContain("p_run -> 'template_snapshot'")
  });

  it("has atomic stale-revision checks for task completion and decisions", () => {
    expect(sql).toContain("create or replace function public.complete_feeding_sop_task");
    expect(sql).toContain("create or replace function public.review_feeding_agent_decision");
    expect(sql.match(/NBJ_AGENT_STALE/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("'run', to_jsonb(v_run)");
  });

  it("starts a run and its complete initial timeline in one transaction", () => {
    expect(sql).toContain("create or replace function public.start_feeding_sop_run");
    expect(sql).toContain("for v_event in select value from jsonb_array_elements(p_events)");
    expect(sql).toContain("grant execute on function public.start_feeding_sop_run");
  });

  it("records laggard supplements atomically and enforces the day-3 gate", () => {
    expect(sql).toContain("record_feeding_laggard_supplement");
    expect(sql).toContain("NBJ_LAGGARD_SUPPLEMENT_REVIEW_REQUIRED");
    expect(sql).toContain("evaluate_feeding_laggard_case");
    expect(sql).toContain("observed_at + interval '48 hours'");
  });

  it("checks the completion idempotency key before rejecting a replay as stale", () => {
    const replay = sql.indexOf("v_event.idempotency_key = p_idempotency_key");
    const stale = sql.indexOf("if v_run.revision <> p_expected_revision", replay);
    expect(replay).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(replay);
  });

  it("cannot complete a cancelled or exception task", () => {
    expect(sql).toContain("v_event.status not in ('pending', 'overdue')");
    expect(sql).toContain("NBJ_SOP_TASK_NOT_ACTIONABLE");
  });

  it("requires field operators to complete SOP tasks in sequence", () => {
    expect(sql).toContain("NBJ_SOP_PREVIOUS_TASK_REQUIRED");
    expect(sql).toContain("prior.status in ('pending', 'overdue')");
    expect(sql).toContain("prior.sequence < v_event.sequence");
  });

  it("advances the state machine and cancels future teaching after confirmation", () => {
    expect(sql).toContain(`@> '{"majorityFeedsConfirmed": true}'::jsonb`);
    expect(sql).toContain("then 'production_feeding'");
    expect(sql).toContain("task_kind in ('teaching_meal', 'laggard_day3_evaluation')");
  });

  it("does not downgrade a run after majority-feeding confirmation", () => {
    expect(sql).toContain("when v_run.majority_feeds_confirmed_at is not null");
    expect(sql).toContain("then 'production_feeding'");
    expect(sql).toContain("where majority_feeds_confirmed_at is not null");
  });

  it("indexes policy and foreign-key access paths", () => {
    expect(sql).toContain("feeding_sop_runs_template_idx");
    expect(sql).toContain("feeding_agent_sessions_run_idx");
    expect(sql).toContain("feeding_agent_decisions_session_idx");
    expect(sql).toContain("feeding_sop_events_operator_idx");
    expect(sql).toContain("feeding_agent_sessions_one_active_batch_idx");
  });

  it("supports one preserved Agent session per batch", () => {
    expect(sql).toContain("create or replace function public.ensure_feeding_agent_session");
    expect(sql).toContain("on conflict (user_id, batch_id) where status = 'active'");
    expect(sql).toContain("NBJ_AGENT_SESSION_RUN_MISMATCH");
    expect(sql).toContain("grant execute on function public.ensure_feeding_agent_session");
  });

  it("publishes the fixed teaching/model-meal SOP for future runs", () => {
    expect(sql).toContain("'pending', 'scheduled', 'completed'");
    expect(sql).toContain("2026.08.03-v5-fixed-teaching-model-meal");
    expect(sql).toContain("'teachingProgramEndDayOffset', 1");
    expect(sql).toContain("'teachingProgramEndLocal', '08:00'");
    expect(sql).toContain("'teachingQuantitySource', 'production_model'");
    expect(sql).toContain("'initialMealCount', 10");
    expect(sql).toContain("'excludedMealTimes', jsonb_build_array('00:00', '12:00')");
    expect(sql).toContain("p_config ->> 'teachingQuantitySource' <> 'production_model'");
    expect(sql).toContain("'quantityAuthorityOrder', jsonb_build_array('sop_direct', 'sop_indirect', 'production_model')");
    expect(sql).toContain("'modelQuantityFallbackEnabled', true");
    expect(sql).toContain("jsonb_build_array('powderGrams', 'timeLocal')");
    expect(sql).toContain("'customTasks', '[]'::jsonb");
  });

  it("does not expose the automatic RLS event-trigger function as an RPC", () => {
    expect(sql).toContain(
      "revoke all on function public.rls_auto_enable() from public, anon, authenticated",
    );
  });
});
