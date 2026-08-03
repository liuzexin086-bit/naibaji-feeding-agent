-- 奶爸机数据系统：Supabase PostgreSQL 初始化/升级脚本
-- 请在 Supabase SQL Editor 完整执行。脚本不会删除 batches 数据。

create table if not exists public.batches (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  config jsonb not null default '{}'::jsonb,
  records jsonb not null default '[]'::jsonb,
  current_day_index integer not null default 0,
  status text not null default 'active',
  config_locked boolean not null default false,
  control_start_day integer not null default -1,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint batches_status_check check (status in ('active', 'completed')),
  constraint batches_current_day_index_check check (current_day_index >= 0),
  constraint batches_control_start_day_check check (control_start_day >= -1),
  constraint batches_revision_check check (revision >= 0)
);

-- 兼容此前仅以 id 为主键的草案：检查真实主键约束后再迁移，绝不删除 batches 数据。
alter table public.batches
  add column if not exists revision bigint not null default 0;

do $$
declare
  v_primary_key_name text;
  v_primary_key_columns text[];
begin
  select
    constraint_row.conname,
    array_agg(attribute_row.attname order by key_row.ord)
  into v_primary_key_name, v_primary_key_columns
  from pg_constraint constraint_row
  join unnest(constraint_row.conkey) with ordinality as key_row(attnum, ord)
    on true
  join pg_attribute attribute_row
    on attribute_row.attrelid = constraint_row.conrelid
   and attribute_row.attnum = key_row.attnum
  where constraint_row.conrelid = 'public.batches'::regclass
    and constraint_row.contype = 'p'
  group by constraint_row.conname;

  if v_primary_key_name is null then
    alter table public.batches
      add constraint batches_pkey primary key (user_id, id);
  elsif v_primary_key_columns is distinct from array['user_id', 'id']::text[] then
    execute format('alter table public.batches drop constraint %I', v_primary_key_name);
    alter table public.batches
      add constraint batches_pkey primary key (user_id, id);
  end if;
end;
$$;

alter table public.batches drop constraint if exists batches_status_check;
alter table public.batches
  add constraint batches_status_check check (status in ('active', 'completed'));

alter table public.batches drop constraint if exists batches_current_day_index_check;
alter table public.batches
  add constraint batches_current_day_index_check check (current_day_index >= 0);

alter table public.batches drop constraint if exists batches_control_start_day_check;
alter table public.batches
  add constraint batches_control_start_day_check check (control_start_day >= -1);

alter table public.batches drop constraint if exists batches_revision_check;
alter table public.batches
  add constraint batches_revision_check check (revision >= 0);

create index if not exists batches_user_id_idx
  on public.batches(user_id);

create index if not exists batches_user_id_updated_at_idx
  on public.batches(user_id, updated_at desc);

create or replace function public.set_batch_metadata()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  new.revision = old.revision + 1;
  return new;
end;
$$;

drop trigger if exists batches_set_updated_at on public.batches;
drop trigger if exists batches_set_metadata on public.batches;
create trigger batches_set_metadata
before update on public.batches
for each row execute function public.set_batch_metadata();

alter table public.batches enable row level security;

drop policy if exists "batches_select_own" on public.batches;
create policy "batches_select_own"
on public.batches
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "batches_insert_own" on public.batches;
create policy "batches_insert_own"
on public.batches
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "batches_update_own" on public.batches;
create policy "batches_update_own"
on public.batches
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "batches_delete_own" on public.batches;
create policy "batches_delete_own"
on public.batches
for delete
to authenticated
using ((select auth.uid()) = user_id);

-- 原子保存：新批次只允许插入；已有批次必须携带读取到的 revision。
-- revision 不一致时抛出 NBJ_CONFLICT，客户端保留本机副本且不覆盖云端。
create or replace function public.save_batch_snapshot(
  p_id text,
  p_config jsonb,
  p_records jsonb,
  p_current_day_index integer,
  p_status text,
  p_config_locked boolean,
  p_control_start_day integer,
  p_created_at timestamptz,
  p_expected_revision bigint
)
returns public.batches
language plpgsql
security invoker
set search_path = public
as $$
declare
  saved public.batches;
  v_row_count bigint;
  v_current_revision bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_expected_revision is null then
    insert into public.batches (
      user_id, id, config, records, current_day_index, status,
      config_locked, control_start_day, revision, created_at
    )
    values (
      auth.uid(), p_id, coalesce(p_config, '{}'::jsonb), coalesce(p_records, '[]'::jsonb),
      p_current_day_index, p_status, p_config_locked, p_control_start_day, 1,
      coalesce(p_created_at, now())
    )
    on conflict (user_id, id) do nothing
    returning * into saved;
    get diagnostics v_row_count = row_count;
  else
    update public.batches
    set
      config = coalesce(p_config, '{}'::jsonb),
      records = coalesce(p_records, '[]'::jsonb),
      current_day_index = p_current_day_index,
      status = p_status,
      config_locked = p_config_locked,
      control_start_day = p_control_start_day
    where user_id = auth.uid()
      and id = p_id
      and revision = p_expected_revision
    returning * into saved;
    get diagnostics v_row_count = row_count;
  end if;

  if v_row_count = 1 then
    return saved;
  end if;

  select revision
  into v_current_revision
  from public.batches
  where user_id = auth.uid()
    and id = p_id;

  raise exception 'NBJ_CONFLICT: expected revision %, actual revision %',
    p_expected_revision,
    v_current_revision
    using errcode = 'P0001';
end;
$$;

grant select, insert, update, delete
on table public.batches
to authenticated;

revoke all
on table public.batches
from anon;

revoke all on function public.save_batch_snapshot(
  text, jsonb, jsonb, integer, text, boolean, integer, timestamptz, bigint
) from public;

revoke all on function public.save_batch_snapshot(
  text, jsonb, jsonb, integer, text, boolean, integer, timestamptz, bigint
) from anon;

grant execute on function public.save_batch_snapshot(
  text, jsonb, jsonb, integer, text, boolean, integer, timestamptz, bigint
) to authenticated;

-- ══════════════════════════════════════════════
-- 管理员后台：角色、用户档案、审计与跨用户受控编辑
-- 本段可重复执行；管理员身份只能由 SQL Editor 手动分配。
-- ══════════════════════════════════════════════

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  constraint user_roles_role_check check (role in ('admin'))
);

alter table public.user_roles
  drop constraint if exists user_roles_role_check;
alter table public.user_roles
  add constraint user_roles_role_check check (role in ('admin')) not valid;

alter table public.user_roles enable row level security;
revoke all on table public.user_roles from public;
revoke all on table public.user_roles from anon;
revoke all on table public.user_roles from authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- 回填执行脚本前已经存在的认证用户；created_at 保持原值。
insert into public.profiles (user_id, email, created_at)
select id, email, created_at
from auth.users
on conflict (user_id) do update
set email = excluded.email;

create or replace function public.sync_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (user_id, email, created_at)
  values (new.id, new.email, coalesce(new.created_at, now()))
  on conflict (user_id) do update
  set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists auth_user_profile_sync on auth.users;
create trigger auth_user_profile_sync
after insert or update of email on auth.users
for each row execute function public.sync_profile_from_auth_user();

revoke all on function public.sync_profile_from_auth_user() from public;

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin"
on public.profiles
for select
to authenticated
using ((select public.is_admin()));

grant select on table public.profiles to authenticated;
revoke all on table public.profiles from anon;
revoke insert, update, delete on table public.profiles from authenticated;

-- 普通用户的 batches 策略保持不变；管理员仅可读取和更新全体批次。
drop policy if exists "batches_select_admin" on public.batches;
create policy "batches_select_admin"
on public.batches
for select
to authenticated
using ((select public.is_admin()));

drop policy if exists "batches_update_admin" on public.batches;

create index if not exists batches_updated_at_idx
  on public.batches(updated_at desc);

create index if not exists batches_config_farm_room_idx
  on public.batches ((config ->> 'farmRoom'));

create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  target_user_id uuid references auth.users(id) on delete set null,
  batch_id text,
  action text not null,
  before_revision bigint,
  after_revision bigint,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_target_batch_idx
  on public.admin_audit_logs(target_user_id, batch_id, created_at desc);

alter table public.admin_audit_logs enable row level security;

drop policy if exists "admin_audit_logs_select_admin" on public.admin_audit_logs;
create policy "admin_audit_logs_select_admin"
on public.admin_audit_logs
for select
to authenticated
using ((select public.is_admin()));

grant select on table public.admin_audit_logs to authenticated;
revoke all on table public.admin_audit_logs from anon;
revoke insert, update, delete on table public.admin_audit_logs from authenticated;

-- 管理员专用原子更新：不接受客户端 user_id 作为管理员身份，仅以 auth.uid() 验证角色。
create or replace function public.admin_save_batch_snapshot(
  p_target_user_id uuid,
  p_id text,
  p_config jsonb,
  p_records jsonb,
  p_current_day_index integer,
  p_status text,
  p_config_locked boolean,
  p_control_start_day integer,
  p_expected_revision bigint
)
returns public.batches
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before public.batches;
  v_saved public.batches;
  v_row_count bigint;
  v_current_revision bigint;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if p_expected_revision is null then
    raise exception 'ADMIN_BATCH_CONFLICT: expected revision is required'
      using errcode = 'P0001';
  end if;

  -- 若下方条件 UPDATE 成功，revision 的单调递增保证这里的快照就是其真实更新前状态。
  select *
  into v_before
  from public.batches
  where user_id = p_target_user_id
    and id = p_id;

  update public.batches
  set
    config = coalesce(p_config, '{}'::jsonb),
    records = coalesce(p_records, '[]'::jsonb),
    current_day_index = p_current_day_index,
    status = p_status,
    config_locked = p_config_locked,
    control_start_day = p_control_start_day
  where user_id = p_target_user_id
    and id = p_id
    and revision = p_expected_revision
  returning * into v_saved;
  get diagnostics v_row_count = row_count;

  if v_row_count <> 1 then
    select revision
    into v_current_revision
    from public.batches
    where user_id = p_target_user_id
      and id = p_id;

    raise exception 'ADMIN_BATCH_CONFLICT: expected revision %, actual revision %',
      p_expected_revision,
      v_current_revision
      using errcode = 'P0001';
  end if;

  insert into public.admin_audit_logs (
    admin_user_id, target_user_id, batch_id, action,
    before_revision, after_revision, before_snapshot, after_snapshot
  )
  values (
    auth.uid(), p_target_user_id, p_id, 'ADMIN_UPDATE_BATCH',
    v_before.revision, v_saved.revision, to_jsonb(v_before), to_jsonb(v_saved)
  );

  return v_saved;
end;
$$;

revoke all on function public.admin_save_batch_snapshot(
  uuid, text, jsonb, jsonb, integer, text, boolean, integer, bigint
) from public;

revoke all on function public.admin_save_batch_snapshot(
  uuid, text, jsonb, jsonb, integer, text, boolean, integer, bigint
) from anon;

grant execute on function public.admin_save_batch_snapshot(
  uuid, text, jsonb, jsonb, integer, text, boolean, integer, bigint
) to authenticated;


-- ============================================================================
-- 奶爸机超早期断奶执行 Agent（2026-07-31，增量且可重复执行）
-- 约束：
--   1. 所有业务数据均由 user_id 隔离，anon 无任何权限。
--   2. SOP 模板发布后不可原地更新或删除；修改必须复制为新版本。
--   3. 运行中批次保存模板快照、模型版本、时区、稀释比和 revision。
--   4. Agent 仅使用用户 JWT；这些函数均为 SECURITY INVOKER。
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.feeding_sop_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  template_key text not null,
  version text not null,
  name text not null,
  config jsonb not null,
  status text not null default 'published',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint feeding_sop_templates_key_check check (length(trim(template_key)) > 0),
  constraint feeding_sop_templates_version_check check (length(trim(version)) > 0),
  constraint feeding_sop_templates_name_check check (length(trim(name)) > 0),
  constraint feeding_sop_templates_config_check check (jsonb_typeof(config) = 'object'),
  constraint feeding_sop_templates_status_check check (status in ('published', 'retired')),
  constraint feeding_sop_templates_owner_creator_check check (user_id = created_by),
  unique (user_id, id),
  unique (template_key, version)
);

create table if not exists public.feeding_sop_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id text not null,
  template_id uuid not null,
  template_version text not null,
  template_snapshot jsonb not null,
  model_version text not null,
  model_hash text not null,
  timezone text not null,
  dilution_ratio text not null,
  phase text not null default 'adaptation',
  revision bigint not null default 0,
  status text not null default 'active',
  active_head_count integer not null,
  admitted_at timestamptz not null,
  first_teaching_at timestamptz not null,
  majority_feeds_confirmed_at timestamptz,
  exception_reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint feeding_sop_runs_batch_fk
    foreign key (user_id, batch_id)
    references public.batches(user_id, id)
    on delete cascade,
  constraint feeding_sop_runs_template_fk
    foreign key (template_id)
    references public.feeding_sop_templates(id)
    on delete restrict,
  constraint feeding_sop_runs_snapshot_check check (jsonb_typeof(template_snapshot) = 'object'),
  constraint feeding_sop_runs_phase_check check (phase in (
    'preparation', 'admission', 'adaptation', 'first_teaching', 'teaching_loop',
    'production_feeding', 'creep_feed', 'milk_soaked_feed', 'transition',
    'completed', 'exception'
  )),
  constraint feeding_sop_runs_status_check check (status in ('active', 'paused', 'completed')),
  constraint feeding_sop_runs_revision_check check (revision >= 0),
  constraint feeding_sop_runs_head_count_check check (active_head_count > 0),
  unique (user_id, id)
);

create unique index if not exists feeding_sop_runs_one_open_batch_idx
  on public.feeding_sop_runs(user_id, batch_id)
  where status in ('active', 'paused');

create table if not exists public.feeding_sop_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  batch_id text not null,
  task_kind text not null,
  title text not null,
  scheduled_at timestamptz not null,
  actual_completed_at timestamptz,
  status text not null default 'pending',
  plan_source text not null,
  sequence integer not null default 0,
  planned_values jsonb not null default '{}'::jsonb,
  actual_values jsonb not null default '{}'::jsonb,
  deviation jsonb,
  exception_type text,
  exception_note text,
  operator_id uuid references auth.users(id) on delete set null,
  idempotency_key text not null,
  run_revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feeding_sop_events_run_fk
    foreign key (user_id, run_id)
    references public.feeding_sop_runs(user_id, id)
    on delete cascade,
  constraint feeding_sop_events_status_check check (status in (
    'pending', 'scheduled', 'completed', 'overdue', 'exception', 'cancelled'
  )),
  constraint feeding_sop_events_plan_source_check check (plan_source in (
    'sop_teaching', 'production_model', 'sop_transition'
  )),
  constraint feeding_sop_events_values_check check (
    jsonb_typeof(planned_values) = 'object'
    and jsonb_typeof(actual_values) = 'object'
    and (deviation is null or jsonb_typeof(deviation) = 'object')
  ),
  constraint feeding_sop_events_sequence_check check (sequence >= 0),
  constraint feeding_sop_events_revision_check check (run_revision >= 0),
  unique (user_id, id),
  unique (user_id, idempotency_key)
);

create table if not exists public.feeding_laggard_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  batch_id text not null,
  pig_tag text not null,
  observed_at timestamptz not null,
  not_approaching_trough boolean not null default false,
  hollow_abdomen boolean not null default false,
  feeding_response text,
  abdomen_state text,
  supplement_count integer not null default 0,
  status text not null default 'open',
  day3_outcome text,
  operator_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feeding_laggard_cases_run_fk
    foreign key (user_id, run_id)
    references public.feeding_sop_runs(user_id, id)
    on delete cascade,
  constraint feeding_laggard_cases_observation_check check (
    not_approaching_trough or hollow_abdomen
  ),
  constraint feeding_laggard_cases_supplement_check check (
    supplement_count between 0 and 3
  ),
  constraint feeding_laggard_cases_status_check check (status in (
    'open', 'keep', 'return_to_sow', 'closed'
  )),
  constraint feeding_laggard_cases_outcome_check check (
    day3_outcome is null or day3_outcome in ('keep', 'return_to_sow')
  ),
  unique (user_id, id),
  unique (user_id, run_id, pig_tag)
);

create table if not exists public.feeding_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id text not null,
  run_id uuid,
  status text not null default 'active',
  provider text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feeding_agent_sessions_batch_fk
    foreign key (user_id, batch_id)
    references public.batches(user_id, id)
    on delete cascade,
  constraint feeding_agent_sessions_run_fk
    foreign key (user_id, run_id)
    references public.feeding_sop_runs(user_id, id)
    on delete set null (run_id),
  constraint feeding_agent_sessions_status_check check (status in ('active', 'closed')),
  unique (user_id, id)
);

create table if not exists public.feeding_agent_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  role text not null,
  content text not null,
  tool_name text,
  tool_call_id text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint feeding_agent_messages_session_fk
    foreign key (user_id, session_id)
    references public.feeding_agent_sessions(user_id, id)
    on delete cascade,
  constraint feeding_agent_messages_role_check check (role in (
    'user', 'assistant', 'tool', 'system'
  )),
  constraint feeding_agent_messages_evidence_check check (jsonb_typeof(evidence) = 'object'),
  unique (user_id, id)
);

create table if not exists public.feeding_agent_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid,
  run_id uuid not null,
  batch_id text not null,
  status text not null default 'pending',
  decision_type text not null,
  title text not null,
  draft jsonb not null,
  evidence jsonb not null,
  model_version text not null,
  sop_version text not null,
  calculation_date date not null,
  based_on_revision bigint not null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  constraint feeding_agent_decisions_session_fk
    foreign key (user_id, session_id)
    references public.feeding_agent_sessions(user_id, id)
    on delete set null (session_id),
  constraint feeding_agent_decisions_run_fk
    foreign key (user_id, run_id)
    references public.feeding_sop_runs(user_id, id)
    on delete cascade,
  constraint feeding_agent_decisions_status_check check (status in (
    'pending', 'approved', 'rejected', 'stale'
  )),
  constraint feeding_agent_decisions_json_check check (
    jsonb_typeof(draft) = 'object' and jsonb_typeof(evidence) = 'object'
  ),
  constraint feeding_agent_decisions_revision_check check (based_on_revision >= 0),
  unique (user_id, id)
);

-- 设备程序事件不要求逐餐人工确认；重复执行脚本时同步扩展状态约束。
alter table public.feeding_sop_events
  drop constraint if exists feeding_sop_events_status_check;
alter table public.feeding_sop_events
  add constraint feeding_sop_events_status_check check (status in (
    'pending', 'scheduled', 'completed', 'overdue', 'exception', 'cancelled'
  )) not valid;
alter table public.feeding_sop_events
  validate constraint feeding_sop_events_status_check;

-- 每个批次只保留一个活动 Agent 会话；历史会话和消息不删除。
with ranked_sessions as (
  select id, user_id, row_number() over (
    partition by user_id, batch_id
    order by updated_at desc, created_at desc, id desc
  ) as active_rank
  from public.feeding_agent_sessions
  where status = 'active'
)
update public.feeding_agent_sessions session_row
set status = 'closed'
from ranked_sessions ranked
where session_row.user_id = ranked.user_id
  and session_row.id = ranked.id
  and ranked.active_rank > 1;

create unique index if not exists feeding_agent_sessions_one_active_batch_idx
  on public.feeding_agent_sessions(user_id, batch_id)
  where status = 'active';

create or replace function public.ensure_feeding_agent_session(
  p_batch_id text,
  p_run_id uuid default null
)
returns public.feeding_agent_sessions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.feeding_agent_sessions;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_run_id is not null and not exists (
    select 1
    from public.feeding_sop_runs run_row
    where run_row.user_id = v_user_id
      and run_row.id = p_run_id
      and run_row.batch_id = p_batch_id
  ) then
    raise exception 'NBJ_AGENT_SESSION_RUN_MISMATCH' using errcode = 'P0001';
  end if;

  insert into public.feeding_agent_sessions (
    user_id, batch_id, run_id, status
  )
  values (
    v_user_id, p_batch_id, p_run_id, 'active'
  )
  on conflict (user_id, batch_id) where status = 'active'
  do update set
    run_id = coalesce(excluded.run_id, feeding_agent_sessions.run_id),
    updated_at = now()
  returning * into v_session;

  return v_session;
end;
$$;

create index if not exists feeding_sop_templates_user_idx
  on public.feeding_sop_templates(user_id, created_at desc);
create index if not exists feeding_sop_runs_user_batch_idx
  on public.feeding_sop_runs(user_id, batch_id, updated_at desc);
create index if not exists feeding_sop_events_timeline_idx
  on public.feeding_sop_events(user_id, run_id, scheduled_at);
create index if not exists feeding_sop_events_open_idx
  on public.feeding_sop_events(user_id, run_id, status, scheduled_at);
create index if not exists feeding_laggard_cases_open_idx
  on public.feeding_laggard_cases(user_id, run_id, status);
create index if not exists feeding_agent_sessions_batch_idx
  on public.feeding_agent_sessions(user_id, batch_id, updated_at desc);
create index if not exists feeding_agent_messages_session_idx
  on public.feeding_agent_messages(user_id, session_id, created_at);
create index if not exists feeding_agent_decisions_pending_idx
  on public.feeding_agent_decisions(user_id, run_id, status, created_at desc);
create index if not exists feeding_sop_templates_created_by_idx
  on public.feeding_sop_templates(created_by);
create index if not exists feeding_sop_runs_template_idx
  on public.feeding_sop_runs(template_id);
create index if not exists feeding_sop_events_operator_idx
  on public.feeding_sop_events(operator_id);
create index if not exists feeding_laggard_cases_operator_idx
  on public.feeding_laggard_cases(operator_id);
create index if not exists feeding_agent_sessions_run_idx
  on public.feeding_agent_sessions(user_id, run_id);
create index if not exists feeding_agent_decisions_session_idx
  on public.feeding_agent_decisions(user_id, session_id);
create index if not exists feeding_agent_decisions_reviewer_idx
  on public.feeding_agent_decisions(reviewed_by);

alter table public.feeding_sop_templates enable row level security;
alter table public.feeding_sop_runs enable row level security;
alter table public.feeding_sop_events enable row level security;
alter table public.feeding_laggard_cases enable row level security;
alter table public.feeding_agent_sessions enable row level security;
alter table public.feeding_agent_messages enable row level security;
alter table public.feeding_agent_decisions enable row level security;

-- 已发布模板向所有登录用户开放；管理员可读取历史版本并发布新版本。
drop policy if exists "feeding_sop_templates_select_own" on public.feeding_sop_templates;
drop policy if exists "feeding_sop_templates_select_published_or_admin" on public.feeding_sop_templates;
create policy "feeding_sop_templates_select_published_or_admin"
on public.feeding_sop_templates for select to authenticated
using (status = 'published' or (select public.is_admin()));

drop policy if exists "feeding_sop_templates_insert_admin" on public.feeding_sop_templates;
create policy "feeding_sop_templates_insert_admin"
on public.feeding_sop_templates for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and (select auth.uid()) = created_by
  and public.is_admin()
);

drop policy if exists "feeding_sop_templates_update_status_admin" on public.feeding_sop_templates;
create policy "feeding_sop_templates_update_status_admin"
on public.feeding_sop_templates for update to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

-- 其余表使用统一的用户隔离策略；WITH CHECK 防止改写 user_id。
drop policy if exists "feeding_sop_runs_own" on public.feeding_sop_runs;
create policy "feeding_sop_runs_own"
on public.feeding_sop_runs for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "feeding_sop_events_own" on public.feeding_sop_events;
create policy "feeding_sop_events_own"
on public.feeding_sop_events for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "feeding_laggard_cases_own" on public.feeding_laggard_cases;
create policy "feeding_laggard_cases_own"
on public.feeding_laggard_cases for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "feeding_agent_sessions_own" on public.feeding_agent_sessions;
create policy "feeding_agent_sessions_own"
on public.feeding_agent_sessions for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "feeding_agent_messages_own" on public.feeding_agent_messages;
create policy "feeding_agent_messages_own"
on public.feeding_agent_messages for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "feeding_agent_decisions_own" on public.feeding_agent_decisions;
create policy "feeding_agent_decisions_own"
on public.feeding_agent_decisions for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on table
  public.feeding_sop_templates,
  public.feeding_sop_runs,
  public.feeding_sop_events,
  public.feeding_laggard_cases,
  public.feeding_agent_sessions,
  public.feeding_agent_messages,
  public.feeding_agent_decisions
from anon;

revoke all on table public.feeding_sop_templates from authenticated;
grant select, insert on table public.feeding_sop_templates to authenticated;
grant update(status) on table public.feeding_sop_templates to authenticated;

grant select, insert, update on table
  public.feeding_sop_runs,
  public.feeding_sop_events,
  public.feeding_laggard_cases,
  public.feeding_agent_sessions,
  public.feeding_agent_messages,
  public.feeding_agent_decisions
to authenticated;

-- 通用 updated_at，不修改 revision；revision 只允许由原子业务函数推进。
create or replace function public.set_feeding_agent_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists feeding_sop_runs_set_updated_at on public.feeding_sop_runs;
create trigger feeding_sop_runs_set_updated_at
before update on public.feeding_sop_runs
for each row execute function public.set_feeding_agent_updated_at();

drop trigger if exists feeding_sop_events_set_updated_at on public.feeding_sop_events;
create trigger feeding_sop_events_set_updated_at
before update on public.feeding_sop_events
for each row execute function public.set_feeding_agent_updated_at();

drop trigger if exists feeding_laggard_cases_set_updated_at on public.feeding_laggard_cases;
create trigger feeding_laggard_cases_set_updated_at
before update on public.feeding_laggard_cases
for each row execute function public.set_feeding_agent_updated_at();

drop trigger if exists feeding_agent_sessions_set_updated_at on public.feeding_agent_sessions;
create trigger feeding_agent_sessions_set_updated_at
before update on public.feeding_agent_sessions
for each row execute function public.set_feeding_agent_updated_at();

-- 将旧的“模板归属用户”外键迁移为全局模板外键，使普通用户可启动管理员发布的模板。
alter table public.feeding_sop_runs
  drop constraint if exists feeding_sop_runs_template_fk;
alter table public.feeding_sop_runs
  add constraint feeding_sop_runs_template_fk
  foreign key (template_id)
  references public.feeding_sop_templates(id)
  on delete restrict;

alter table public.feeding_sop_templates
  drop constraint if exists feeding_sop_templates_user_id_template_key_version_key;
create unique index if not exists feeding_sop_templates_global_version_idx
  on public.feeding_sop_templates(template_key, version);

drop index if exists public.feeding_sop_runs_template_idx;
create index feeding_sop_runs_template_idx
  on public.feeding_sop_runs(template_id);

-- 模板正文永久不可原地修改；唯一允许的更新是 published -> retired。
create or replace function public.enforce_feeding_sop_template_immutability()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'NBJ_SOP_TEMPLATE_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'published' and new.status = 'retired') then
    raise exception 'NBJ_SOP_TEMPLATE_STATUS_INVALID' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists feeding_sop_templates_immutable on public.feeding_sop_templates;
create trigger feeding_sop_templates_immutable
before update on public.feeding_sop_templates
for each row execute function public.enforce_feeding_sop_template_immutability();

-- 未来批次默认使用设备程序版 SOP；已经启动的 run 继续使用原 template_snapshot。
insert into public.feeding_sop_templates (
  user_id, template_key, version, name, config, status, created_by
)
select
  source.user_id,
  source.template_key,
  '2026.07.31-v2-device-program',
  '奶爸机超早期断奶 SOP · 设备程序版',
  source.config || jsonb_build_object(
    'version', '2026.07.31-v2-device-program',
    'waterClosedBeforeAgeDays', 12,
    'teachingProgramEnabled', true,
    'gentleMovementEnabled', true,
    'laggardEvaluationEnabled', true,
    'creepFeedEnabled', true,
    'soakedFeedEnabled', true,
    'transitionEnabled', true,
    'maintenanceEnabled', true,
    'productionProgramStartLocal', '00:00',
    'customTasks', '[]'::jsonb
  ),
  'published',
  source.created_by
from public.feeding_sop_templates source
where source.template_key = 'naibaji-early-weaning'
order by
  case when source.status = 'published' then 0 else 1 end,
  source.created_at desc
limit 1
on conflict (template_key, version) do nothing;

update public.feeding_sop_templates
set status = 'retired'
where template_key = 'naibaji-early-weaning'
  and version = '2026.07.31-v1'
  and status = 'published'
  and exists (
    select 1
    from public.feeding_sop_templates replacement
    where replacement.template_key = 'naibaji-early-weaning'
      and replacement.version = '2026.07.31-v2-device-program'
      and replacement.status = 'published'
  );

-- 未来批次默认使用首夜至次日 08:00 教奶 + 模型单次量；运行中批次继续使用冻结快照。
insert into public.feeding_sop_templates (
  user_id, template_key, version, name, config, status, created_by
)
select
  source.user_id,
  source.template_key,
  '2026.07.31-v3-first-night-model',
  '奶爸机超早期断奶 SOP · 首夜模型下奶版',
  source.config || jsonb_build_object(
    'version', '2026.07.31-v3-first-night-model',
    'teachingProgramEndDayOffset', 1,
    'teachingProgramEndLocal', '08:00',
    'teachingQuantitySource', 'production_model',
    'deviceConfigurationFields', jsonb_build_array('powderGrams', 'timeLocal')
  ),
  'published',
  source.created_by
from public.feeding_sop_templates source
where source.template_key = 'naibaji-early-weaning'
order by
  case
    when source.version = '2026.07.31-v2-device-program' then 0
    when source.status = 'published' then 1
    else 2
  end,
  source.created_at desc
limit 1
on conflict (template_key, version) do nothing;

update public.feeding_sop_templates
set status = 'retired'
where template_key = 'naibaji-early-weaning'
  and version = '2026.07.31-v2-device-program'
  and status = 'published'
  and exists (
    select 1
    from public.feeding_sop_templates replacement
    where replacement.template_key = 'naibaji-early-weaning'
      and replacement.version = '2026.07.31-v3-first-night-model'
      and replacement.status = 'published'
  );

-- V4 数量权威：SOP 直接总量 > SOP 参数推导总量 > 生产模型兜底。
-- 运行中批次继续使用各自冻结的 V1/V2/V3 快照，仅未来批次选择 V4。
insert into public.feeding_sop_templates (
  user_id, template_key, version, name, config, status, created_by
)
select
  source.user_id,
  source.template_key,
  '2026.07.31-v4-sop-priority',
  '奶爸机超早期断奶 SOP · SOP 数量优先版',
  source.config || jsonb_build_object(
    'version', '2026.07.31-v4-sop-priority',
    'teachingDirectTotalPowderGrams', 0,
    'quantityAuthorityOrder', jsonb_build_array('sop_direct', 'sop_indirect', 'production_model'),
    'modelQuantityFallbackEnabled', true,
    'teachingQuantitySource', 'sop'
  ),
  'published',
  source.created_by
from public.feeding_sop_templates source
where source.template_key = 'naibaji-early-weaning'
order by
  case
    when source.version = '2026.07.31-v3-first-night-model' then 0
    when source.status = 'published' then 1
    else 2
  end,
  source.created_at desc
limit 1
on conflict (template_key, version) do nothing;

update public.feeding_sop_templates
set status = 'retired'
where template_key = 'naibaji-early-weaning'
  and version = '2026.07.31-v3-first-night-model'
  and status = 'published'
  and exists (
    select 1
    from public.feeding_sop_templates replacement
    where replacement.template_key = 'naibaji-early-weaning'
      and replacement.version = '2026.07.31-v4-sop-priority'
      and replacement.status = 'published'
  );

-- V5 固定教奶时段；教奶单次量使用模型，正式饲喂初始 10 餐且避开 00:00/12:00。
insert into public.feeding_sop_templates (
  user_id, template_key, version, name, config, status, created_by
)
select
  source.user_id,
  source.template_key,
  '2026.08.03-v5-fixed-teaching-model-meal',
  '奶爸机超早期断奶 SOP · 固定教奶模型单次版',
  source.config || jsonb_build_object(
    'version', '2026.08.03-v5-fixed-teaching-model-meal',
    'preferredFirstTeachingLocal', '17:00',
    'teachingProgramEndDayOffset', 1,
    'teachingProgramEndLocal', '08:00',
    'teachingQuantitySource', 'production_model',
    'productionProgramStartLocal', '02:00',
    'initialMealCount', 10,
    'excludedMealTimes', jsonb_build_array('00:00', '12:00')
  ),
  'published',
  source.created_by
from public.feeding_sop_templates source
where source.template_key = 'naibaji-early-weaning'
order by
  case
    when source.version = '2026.07.31-v4-sop-priority' then 0
    when source.status = 'published' then 1
    else 2
  end,
  source.created_at desc
limit 1
on conflict (template_key, version) do nothing;

update public.feeding_sop_templates
set status = 'retired'
where template_key = 'naibaji-early-weaning'
  and version = '2026.07.31-v4-sop-priority'
  and status = 'published'
  and exists (
    select 1
    from public.feeding_sop_templates replacement
    where replacement.template_key = 'naibaji-early-weaning'
      and replacement.version = '2026.08.03-v5-fixed-teaching-model-meal'
      and replacement.status = 'published'
  );

-- 管理员以“复制并发布”创建新版本；可选地在同一事务中退役来源版本。
create or replace function public.admin_publish_feeding_sop_template(
  p_base_template_id uuid,
  p_template_key text,
  p_version text,
  p_name text,
  p_config jsonb,
  p_retire_base boolean default true
)
returns public.feeding_sop_templates
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_base public.feeding_sop_templates;
  v_result public.feeding_sop_templates;
  v_template_key text;
  v_required_key text;
  v_required_keys constant text[] := array[
    'timezone', 'utcOffsetMinutes', 'defaultAdmissionDeadlineLocal',
    'preferredFirstTeachingLocal', 'adaptationMinHours', 'adaptationMaxHours',
    'teachingIntervalHours', 'teachingLiquidMlPerHead',
    'teachingPowderGramsPerTwenty', 'devicePowderPrecisionGrams',
    'teachingProgramEndDayOffset', 'teachingProgramEndLocal',
    'teachingDirectTotalPowderGrams', 'quantityAuthorityOrder',
    'modelQuantityFallbackEnabled', 'teachingQuantitySource',
    'deviceConfigurationFields', 'teachingLatestDay',
    'waterClosedBeforeAgeDays', 'waterPolicyEnabled',
    'standardCleanEveryDays', 'deepCleanEveryDays', 'creepAgeStart',
    'creepAgeEnd', 'soakedFeedAgeStart', 'soakedFeedAgeEnd',
    'soakedFeedRatio', 'transitionAgeStart', 'transitionMealsMin',
    'transitionMealsMax'
  ];
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_config) <> 'object' then
    raise exception 'NBJ_SOP_TEMPLATE_CONFIG_INVALID' using errcode = '22023';
  end if;
  if nullif(trim(p_version), '') is null or nullif(trim(p_name), '') is null then
    raise exception 'NBJ_SOP_TEMPLATE_FIELDS_REQUIRED' using errcode = '22023';
  end if;

  if p_base_template_id is not null then
    select * into v_base
    from public.feeding_sop_templates
    where id = p_base_template_id
    for update;
    if not found then
      raise exception 'NBJ_SOP_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
    end if;
    v_template_key := v_base.template_key;
  else
    v_template_key := nullif(trim(p_template_key), '');
  end if;
  if v_template_key is null then
    raise exception 'NBJ_SOP_TEMPLATE_KEY_REQUIRED' using errcode = '22023';
  end if;

  foreach v_required_key in array v_required_keys loop
    if not (p_config ? v_required_key) then
      raise exception 'NBJ_SOP_TEMPLATE_CONFIG_MISSING:%', v_required_key
        using errcode = '22023';
    end if;
  end loop;
  if coalesce((p_config ->> 'teachingProgramEndDayOffset')::numeric, -1) < 0 then
    raise exception 'NBJ_SOP_TEACHING_PROGRAM_END_DAY_INVALID' using errcode = '22023';
  end if;
  if coalesce(p_config ->> 'teachingProgramEndLocal', '') !~ '^[0-2][0-9]:[0-5][0-9]$'
     or split_part(p_config ->> 'teachingProgramEndLocal', ':', 1)::integer > 23 then
    raise exception 'NBJ_SOP_TEACHING_PROGRAM_END_TIME_INVALID' using errcode = '22023';
  end if;
  if p_config ->> 'teachingQuantitySource' <> 'production_model' then
    raise exception 'NBJ_SOP_TEACHING_QUANTITY_SOURCE_INVALID' using errcode = '22023';
  end if;
  if p_config -> 'quantityAuthorityOrder'
     <> jsonb_build_array('sop_direct', 'sop_indirect', 'production_model') then
    raise exception 'NBJ_SOP_QUANTITY_AUTHORITY_ORDER_INVALID' using errcode = '22023';
  end if;
  if coalesce((p_config ->> 'modelQuantityFallbackEnabled')::boolean, false) is not true then
    raise exception 'NBJ_SOP_MODEL_QUANTITY_FALLBACK_REQUIRED' using errcode = '22023';
  end if;
  if coalesce((p_config ->> 'teachingDirectTotalPowderGrams')::numeric, -1) < 0
     or coalesce((p_config ->> 'teachingPowderGramsPerTwenty')::numeric, -1) < 0 then
    raise exception 'NBJ_SOP_TEACHING_QUANTITY_INVALID' using errcode = '22023';
  end if;
  if p_config -> 'deviceConfigurationFields'
     <> jsonb_build_array('powderGrams', 'timeLocal') then
    raise exception 'NBJ_SOP_DEVICE_FIELDS_INVALID' using errcode = '22023';
  end if;

  insert into public.feeding_sop_templates (
    user_id, template_key, version, name, config, status, created_by
  )
  values (
    v_user_id,
    v_template_key,
    trim(p_version),
    trim(p_name),
    p_config || jsonb_build_object(
      'templateId', v_template_key,
      'version', trim(p_version)
    ),
    'published',
    v_user_id
  )
  returning * into v_result;

  if p_retire_base and v_base.id is not null and v_base.status = 'published' then
    update public.feeding_sop_templates
    set status = 'retired'
    where id = v_base.id;
  end if;
  return v_result;
end;
$$;

-- 原子启动 SOP：忽略客户端 user_id，以 auth.uid() 写入 run 与全部初始事件。
create or replace function public.start_feeding_sop_run(
  p_run jsonb,
  p_events jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_run public.feeding_sop_runs;
  v_template public.feeding_sop_templates;
  v_template_snapshot jsonb;
  v_event jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_run) <> 'object' or jsonb_typeof(p_events) <> 'array' then
    raise exception 'NBJ_SOP_START_PAYLOAD_INVALID' using errcode = '22023';
  end if;

  select * into v_template
  from public.feeding_sop_templates
  where id = (p_run ->> 'template_id')::uuid
    and status = 'published';
  if not found then
    raise exception 'NBJ_SOP_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_template_snapshot := v_template.config || jsonb_build_object(
    'templateId', v_template.template_key,
    'version', v_template.version
  );

  insert into public.feeding_sop_runs (
    id, user_id, batch_id, template_id, template_version, template_snapshot,
    model_version, model_hash, timezone, dilution_ratio, phase, revision, status,
    active_head_count, admitted_at, first_teaching_at, started_at
  )
  values (
    (p_run ->> 'id')::uuid,
    v_user_id,
    p_run ->> 'batch_id',
    v_template.id,
    v_template.version,
    v_template_snapshot,
    p_run ->> 'model_version',
    p_run ->> 'model_hash',
    v_template_snapshot ->> 'timezone',
    p_run ->> 'dilution_ratio',
    p_run ->> 'phase',
    (p_run ->> 'revision')::bigint,
    p_run ->> 'status',
    (p_run ->> 'active_head_count')::integer,
    (p_run ->> 'admitted_at')::timestamptz,
    (p_run ->> 'first_teaching_at')::timestamptz,
    (p_run ->> 'started_at')::timestamptz
  )
  returning * into v_run;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    insert into public.feeding_sop_events (
      id, user_id, run_id, batch_id, task_kind, title, scheduled_at, status,
      plan_source, sequence, planned_values, idempotency_key, run_revision
    )
    values (
      (v_event ->> 'id')::uuid,
      v_user_id,
      v_run.id,
      v_run.batch_id,
      v_event ->> 'task_kind',
      v_event ->> 'title',
      (v_event ->> 'scheduled_at')::timestamptz,
      v_event ->> 'status',
      v_event ->> 'plan_source',
      (v_event ->> 'sequence')::integer,
      coalesce(v_event -> 'planned_values', '{}'::jsonb),
      v_event ->> 'idempotency_key',
      v_run.revision
    );
  end loop;

  return jsonb_build_object(
    'run', to_jsonb(v_run),
    'events', (
      select coalesce(jsonb_agg(to_jsonb(e) order by e.scheduled_at, e.sequence), '[]'::jsonb)
      from public.feeding_sop_events e
      where e.user_id = v_user_id and e.run_id = v_run.id
    )
  );
end;
$$;

-- 原子完成任务：revision 不一致返回 NBJ_AGENT_STALE；重复完成保持幂等。
create or replace function public.complete_feeding_sop_task(
  p_event_id uuid,
  p_expected_revision bigint,
  p_actual_completed_at timestamptz,
  p_actual_values jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_event public.feeding_sop_events;
  v_run public.feeding_sop_runs;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_expected_revision is null then
    raise exception 'NBJ_AGENT_STALE' using errcode = 'P0001';
  end if;

  select * into v_event
  from public.feeding_sop_events
  where user_id = v_user_id and id = p_event_id
  for update;

  if not found then
    raise exception 'NBJ_SOP_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_run
  from public.feeding_sop_runs
  where user_id = v_user_id and id = v_event.run_id
  for update;

  if v_event.status = 'completed'
     and v_event.idempotency_key = p_idempotency_key then
    return jsonb_build_object(
      'event', to_jsonb(v_event),
      'run', to_jsonb(v_run),
      'runRevision', v_run.revision,
      'idempotentReplay', true
    );
  end if;

  if v_event.status not in ('pending', 'overdue') then
    raise exception 'NBJ_SOP_TASK_NOT_ACTIONABLE: status %', v_event.status
      using errcode = 'P0001';
  end if;

  if v_run.revision <> p_expected_revision then
    raise exception 'NBJ_AGENT_STALE: expected %, actual %',
      p_expected_revision, v_run.revision
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.feeding_sop_events prior
    where prior.user_id = v_user_id
      and prior.run_id = v_event.run_id
      and prior.status in ('pending', 'overdue')
      and prior.sequence < v_event.sequence
  ) then
    raise exception 'NBJ_SOP_PREVIOUS_TASK_REQUIRED'
      using errcode = 'P0001';
  end if;

  update public.feeding_sop_events
  set
    status = 'completed',
    actual_completed_at = coalesce(p_actual_completed_at, now()),
    actual_values = coalesce(p_actual_values, '{}'::jsonb),
    operator_id = v_user_id,
    idempotency_key = p_idempotency_key,
    run_revision = v_run.revision + 1
  where user_id = v_user_id and id = p_event_id
  returning * into v_event;

  update public.feeding_sop_runs
  set
    revision = revision + 1,
    phase = case
      when v_run.majority_feeds_confirmed_at is not null
        then 'production_feeding'
      when v_event.task_kind = 'teaching_meal'
           and coalesce(p_actual_values, '{}'::jsonb)
             @> '{"majorityFeedsConfirmed": true}'::jsonb
        then 'production_feeding'
      when v_event.task_kind = 'teaching_meal'
           and v_event.scheduled_at = v_run.first_teaching_at
        then 'first_teaching'
      when v_event.task_kind = 'gentle_movement'
        then 'teaching_loop'
      when v_event.task_kind = 'inspection'
        then 'production_feeding'
      when v_event.task_kind = 'creep_feed'
        then 'creep_feed'
      when v_event.task_kind = 'milk_soaked_feed'
        then 'milk_soaked_feed'
      when v_event.task_kind = 'transition_feed'
        then 'transition'
      when v_event.task_kind = 'batch_end_clean'
        then 'completed'
      else phase
    end,
    majority_feeds_confirmed_at = case
      when coalesce(p_actual_values, '{}'::jsonb)
           @> '{"majorityFeedsConfirmed": true}'::jsonb
        then coalesce(p_actual_completed_at, now())
      else majority_feeds_confirmed_at
    end,
    status = case
      when v_event.task_kind = 'batch_end_clean' then 'completed'
      else status
    end,
    completed_at = case
      when v_event.task_kind = 'batch_end_clean' then coalesce(p_actual_completed_at, now())
      else completed_at
    end
  where user_id = v_user_id and id = v_run.id
  returning * into v_run;

  if coalesce(p_actual_values, '{}'::jsonb)
     @> '{"majorityFeedsConfirmed": true}'::jsonb then
    update public.feeding_sop_events
    set status = 'cancelled'
    where user_id = v_user_id
      and run_id = v_run.id
      and status = 'pending'
      and task_kind in ('teaching_meal', 'laggard_day3_evaluation')
      and scheduled_at > coalesce(p_actual_completed_at, now());
  end if;

  return jsonb_build_object(
    'event', to_jsonb(v_event),
    'run', to_jsonb(v_run),
    'runRevision', v_run.revision,
    'idempotentReplay', false
  );
end;
$$;

-- 修正历史乱序确认：多数仔猪主动到槽后，后续任务不能把阶段降回教奶循环。
update public.feeding_sop_runs
set phase = 'production_feeding'
where majority_feeds_confirmed_at is not null
  and phase in ('first_teaching', 'teaching_loop');

-- 原子异常记录：异常不会自动控制设备，只暂停标准建议并推进 revision。
create or replace function public.record_feeding_sop_exception(
  p_event_id uuid,
  p_expected_revision bigint,
  p_exception_type text,
  p_exception_note text,
  p_actual_values jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_event public.feeding_sop_events;
  v_run public.feeding_sop_runs;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_event
  from public.feeding_sop_events
  where user_id = v_user_id and id = p_event_id
  for update;
  if not found then
    raise exception 'NBJ_SOP_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_run
  from public.feeding_sop_runs
  where user_id = v_user_id and id = v_event.run_id
  for update;
  if v_run.revision <> p_expected_revision then
    raise exception 'NBJ_AGENT_STALE: expected %, actual %',
      p_expected_revision, v_run.revision
      using errcode = 'P0001';
  end if;

  update public.feeding_sop_events
  set
    status = 'exception',
    actual_completed_at = now(),
    actual_values = coalesce(p_actual_values, '{}'::jsonb),
    exception_type = p_exception_type,
    exception_note = p_exception_note,
    operator_id = v_user_id,
    run_revision = v_run.revision + 1
  where user_id = v_user_id and id = p_event_id
  returning * into v_event;

  update public.feeding_sop_runs
  set
    revision = revision + 1,
    phase = 'exception',
    status = 'paused',
    exception_reason = concat_ws(': ', p_exception_type, p_exception_note)
  where user_id = v_user_id and id = v_run.id
  returning * into v_run;

  return jsonb_build_object('event', to_jsonb(v_event), 'run', to_jsonb(v_run));
end;
$$;

-- 人工审批建议：旧 revision 必须明确返回 NBJ_AGENT_STALE。
create or replace function public.review_feeding_agent_decision(
  p_decision_id uuid,
  p_expected_revision bigint,
  p_action text,
  p_review_note text
)
returns public.feeding_agent_decisions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_decision public.feeding_agent_decisions;
  v_run public.feeding_sop_runs;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_action not in ('approve', 'reject') then
    raise exception 'NBJ_AGENT_INVALID_REVIEW_ACTION' using errcode = '22023';
  end if;

  select * into v_decision
  from public.feeding_agent_decisions
  where user_id = v_user_id and id = p_decision_id
  for update;
  if not found then
    raise exception 'NBJ_AGENT_DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_run
  from public.feeding_sop_runs
  where user_id = v_user_id and id = v_decision.run_id
  for update;

  if v_run.revision <> p_expected_revision
     or v_decision.based_on_revision <> p_expected_revision then
    update public.feeding_agent_decisions
    set status = 'stale'
    where user_id = v_user_id and id = p_decision_id;
    raise exception 'NBJ_AGENT_STALE: expected %, actual %',
      p_expected_revision, v_run.revision
      using errcode = 'P0001';
  end if;

  update public.feeding_agent_decisions
  set
    status = case when p_action = 'approve' then 'approved' else 'rejected' end,
    reviewed_by = v_user_id,
    reviewed_at = now(),
    review_note = p_review_note
  where user_id = v_user_id and id = p_decision_id
    and status = 'pending'
  returning * into v_decision;

  if not found then
    raise exception 'NBJ_AGENT_DECISION_ALREADY_REVIEWED' using errcode = 'P0001';
  end if;
  return v_decision;
end;
$$;

create or replace function public.record_feeding_laggard_supplement(
  p_case_id uuid,
  p_expected_count integer
)
returns public.feeding_laggard_cases
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_case public.feeding_laggard_cases;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into v_case
  from public.feeding_laggard_cases
  where user_id = v_user_id and id = p_case_id
  for update;
  if not found then
    raise exception 'NBJ_LAGGARD_CASE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_case.status <> 'open' then
    raise exception 'NBJ_LAGGARD_CASE_CLOSED' using errcode = 'P0001';
  end if;
  if v_case.supplement_count <> p_expected_count then
    raise exception 'NBJ_AGENT_STALE: expected %, actual %',
      p_expected_count, v_case.supplement_count
      using errcode = 'P0001';
  end if;
  if v_case.supplement_count >= 3 then
    raise exception 'NBJ_LAGGARD_SUPPLEMENT_REVIEW_REQUIRED' using errcode = 'P0001';
  end if;
  update public.feeding_laggard_cases
  set supplement_count = supplement_count + 1, operator_id = v_user_id
  where user_id = v_user_id and id = p_case_id
  returning * into v_case;
  return v_case;
end;
$$;

create or replace function public.evaluate_feeding_laggard_case(
  p_case_id uuid,
  p_outcome text
)
returns public.feeding_laggard_cases
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_case public.feeding_laggard_cases;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_outcome not in ('keep', 'return_to_sow') then
    raise exception 'NBJ_LAGGARD_INVALID_OUTCOME' using errcode = '22023';
  end if;
  select * into v_case
  from public.feeding_laggard_cases
  where user_id = v_user_id and id = p_case_id
  for update;
  if not found then
    raise exception 'NBJ_LAGGARD_CASE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if now() < v_case.observed_at + interval '48 hours' then
    raise exception 'NBJ_LAGGARD_DAY3_NOT_REACHED' using errcode = 'P0001';
  end if;
  update public.feeding_laggard_cases
  set
    day3_outcome = p_outcome,
    status = p_outcome,
    operator_id = v_user_id
  where user_id = v_user_id and id = p_case_id
  returning * into v_case;
  return v_case;
end;
$$;

revoke all on function public.complete_feeding_sop_task(
  uuid, bigint, timestamptz, jsonb, text
) from public, anon;
grant execute on function public.complete_feeding_sop_task(
  uuid, bigint, timestamptz, jsonb, text
) to authenticated;

revoke all on function public.start_feeding_sop_run(jsonb, jsonb)
from public, anon;
grant execute on function public.start_feeding_sop_run(jsonb, jsonb)
to authenticated;

revoke all on function public.ensure_feeding_agent_session(text, uuid)
from public, anon;
grant execute on function public.ensure_feeding_agent_session(text, uuid)
to authenticated;

revoke all on function public.admin_publish_feeding_sop_template(
  uuid, text, text, text, jsonb, boolean
) from public, anon;
grant execute on function public.admin_publish_feeding_sop_template(
  uuid, text, text, text, jsonb, boolean
) to authenticated;

revoke all on function public.record_feeding_sop_exception(
  uuid, bigint, text, text, jsonb
) from public, anon;
grant execute on function public.record_feeding_sop_exception(
  uuid, bigint, text, text, jsonb
) to authenticated;

revoke all on function public.review_feeding_agent_decision(
  uuid, bigint, text, text
) from public, anon;
grant execute on function public.review_feeding_agent_decision(
  uuid, bigint, text, text
) to authenticated;

revoke all on function public.record_feeding_laggard_supplement(uuid, integer)
from public, anon;
grant execute on function public.record_feeding_laggard_supplement(uuid, integer)
to authenticated;

revoke all on function public.evaluate_feeding_laggard_case(uuid, text)
from public, anon;
grant execute on function public.evaluate_feeding_laggard_case(uuid, text)
to authenticated;

-- Supabase 自动 RLS event trigger 不应作为 Data API RPC 暴露。
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
