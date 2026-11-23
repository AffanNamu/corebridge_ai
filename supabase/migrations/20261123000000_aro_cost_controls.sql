-- ARO AI — cost controls: per-plan rate limits and run caps, per-request
-- usage/cost traces, a daily GPU budget with alerts and a circuit breaker,
-- and an exact-match response cache.
--
-- Same security model as the entitlement tables: RLS on, no policies, and
-- every function executable by service_role only.

-- ------------------------------------------------------ plan guardrails

alter table public.aro_plans
  add column requests_per_minute integer not null default 10 check (requests_per_minute > 0),
  add column requests_per_hour   integer not null default 120 check (requests_per_hour > 0),
  -- Longest answer ARO may write for this plan (tokens).
  add column max_output_tokens   integer not null default 2048 check (max_output_tokens between 64 and 32768),
  -- Coding agent: model calls per run, and tokens (in + out) per run.
  add column agent_max_steps     integer not null default 25 check (agent_max_steps between 1 and 200),
  add column agent_max_tokens    integer not null default 400000 check (agent_max_tokens >= 1000);

update public.aro_plans set requests_per_minute = 6,  requests_per_hour = 60,   max_output_tokens = 1024,
                            agent_max_steps = 15, agent_max_tokens = 150000  where id = 'free';
update public.aro_plans set requests_per_minute = 20, requests_per_hour = 400,  max_output_tokens = 4096,
                            agent_max_steps = 25, agent_max_tokens = 600000  where id = 'pro';
update public.aro_plans set requests_per_minute = 40, requests_per_hour = 1000, max_output_tokens = 8192,
                            agent_max_steps = 40, agent_max_tokens = 1500000 where id = 'premium';

-- ------------------------------------------------------------- tables

-- Fixed-window request counters ('m' = minute, 'h' = hour).
create table public.aro_rate_counters (
  user_id      text not null,
  bucket       text not null check (bucket in ('m', 'h')),
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, bucket, window_start)
);

-- One row of settings, editable from the admin dashboard.
create table public.aro_cost_settings (
  id                    boolean primary key default true check (id),
  -- Spend on ARO's own GPUs per UTC day. At the soft budget the lowest-priority
  -- plans (Free) stop using ARO models; at the hard budget every plan does.
  -- Bring-your-own-key requests are never blocked by the budget.
  daily_budget_usd      numeric(10, 2) not null default 5 check (daily_budget_usd >= 0),
  hard_budget_usd       numeric(10, 2) not null default 10 check (hard_budget_usd >= 0),
  alert_thresholds      numeric[] not null default '{0.5,0.8,1.0}',
  -- Serverless GPU price per second while a worker runs (RTX 4090 flex rate).
  -- An upper bound: vLLM batches concurrent requests on one GPU.
  gpu_usd_per_second    numeric(12, 8) not null default 0.00031,
  -- Backup API used when ARO's server is down (ARO_FALLBACK_*), per 1M tokens.
  fallback_usd_per_mtok_in  numeric(10, 4) not null default 0,
  fallback_usd_per_mtok_out numeric(10, 4) not null default 0,
  -- Exact-match cache for single-turn ARO questions; 0 turns it off.
  cache_ttl_seconds     integer not null default 21600 check (cache_ttl_seconds >= 0),
  updated_at            timestamptz not null default now()
);
insert into public.aro_cost_settings default values;

-- One row per model call: who, which model, tokens, time and estimated cost.
-- Never the prompt or the answer.
create table public.aro_usage_events (
  id            bigint generated always as identity primary key,
  trace_id      uuid not null,
  user_id       text not null,
  surface       text not null check (surface in ('chat', 'agent')),
  provider      text not null,
  model         text not null,
  served_by     text not null,
  aro_model     text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  latency_ms    integer not null default 0,
  cost_usd      numeric(12, 6) not null default 0,
  status        text not null default 'ok' check (status in ('ok', 'error', 'cache_hit', 'stopped')),
  created_at    timestamptz not null default now()
);
create index aro_usage_events_time on public.aro_usage_events (created_at desc);
create index aro_usage_events_user on public.aro_usage_events (user_id, created_at desc);
create index aro_usage_events_trace on public.aro_usage_events (trace_id);

create table public.aro_spend_daily (
  day      date primary key,
  cost_usd numeric(12, 6) not null default 0,
  calls    integer not null default 0
);

create table public.aro_budget_alerts (
  day       date not null,
  threshold numeric not null,
  spent_usd numeric(12, 6) not null,
  created_at timestamptz not null default now(),
  primary key (day, threshold)
);

create table public.aro_response_cache (
  key        text primary key,          -- sha256 of model + prompt, computed by the Edge Function
  model      text not null,
  response   text not null,
  hits       integer not null default 0,
  created_at timestamptz not null default now()
);
create index aro_response_cache_time on public.aro_response_cache (created_at);

do $$
declare t text;
begin
  foreach t in array array[
    'aro_rate_counters', 'aro_cost_settings', 'aro_usage_events', 'aro_spend_daily',
    'aro_budget_alerts', 'aro_response_cache'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ------------------------------------------------------------ functions

-- Checks the user's request rate (every provider) and, for requests served
-- by ARO's own GPUs, the daily budget. Counts this request.
-- Returns {allowed, reason?, retry_after_s?, plan, max_output_tokens, agent_max_steps, agent_max_tokens}.
create or replace function public.aro_gate(p_user text, p_own_gpu boolean)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_plan     aro_plans;
  v_set      aro_cost_settings;
  v_minute   timestamptz := date_trunc('minute', now());
  v_hour     timestamptz := date_trunc('hour', now());
  v_m        integer;
  v_h        integer;
  v_spent    numeric;
  v_limits   jsonb;
begin
  select * into v_plan from aro_plans where id = aro_current_plan(p_user);
  select * into v_set from aro_cost_settings where id;
  v_limits := jsonb_build_object(
    'plan', v_plan.id, 'max_output_tokens', v_plan.max_output_tokens,
    'agent_max_steps', v_plan.agent_max_steps, 'agent_max_tokens', v_plan.agent_max_tokens);

  -- Old windows are useless; this user's rows are cheap to clean (primary key).
  delete from aro_rate_counters where user_id = p_user and window_start < v_hour - interval '1 hour';

  insert into aro_rate_counters (user_id, bucket, window_start, count) values (p_user, 'm', v_minute, 1)
  on conflict (user_id, bucket, window_start) do update set count = aro_rate_counters.count + 1
  returning count into v_m;
  insert into aro_rate_counters (user_id, bucket, window_start, count) values (p_user, 'h', v_hour, 1)
  on conflict (user_id, bucket, window_start) do update set count = aro_rate_counters.count + 1
  returning count into v_h;

  if v_m > v_plan.requests_per_minute then
    return v_limits || jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'window', 'minute',
      'limit', v_plan.requests_per_minute,
      'retry_after_s', ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer);
  end if;
  if v_h > v_plan.requests_per_hour then
    return v_limits || jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'window', 'hour',
      'limit', v_plan.requests_per_hour,
      'retry_after_s', ceil(extract(epoch from (v_hour + interval '1 hour' - now())))::integer);
  end if;

  if p_own_gpu then
    select coalesce(cost_usd, 0) into v_spent from aro_spend_daily where day = (now() at time zone 'utc')::date;
    v_spent := coalesce(v_spent, 0);
    if v_spent >= v_set.hard_budget_usd
       or (v_spent >= v_set.daily_budget_usd and v_plan.priority <= 0) then
      return v_limits || jsonb_build_object('allowed', false, 'reason', 'budget_exceeded',
        'retry_after_s', ceil(extract(epoch from (date_trunc('day', now() at time zone 'utc') + interval '1 day'
                                                  - (now() at time zone 'utc'))))::integer);
    end if;
  end if;

  return v_limits || jsonb_build_object('allowed', true);
end $$;

-- Records one model call and returns the running daily spend plus any budget
-- alert thresholds this call crossed (each fires once per day).
-- p_event: {trace_id, user_id, surface, provider, model, served_by, aro_model?,
--           input_tokens?, output_tokens?, cached_tokens?, latency_ms?, status?}
create or replace function public.aro_log_usage(p_event jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_set     aro_cost_settings;
  v_in      integer := greatest(coalesce((p_event->>'input_tokens')::integer, 0), 0);
  v_out     integer := greatest(coalesce((p_event->>'output_tokens')::integer, 0), 0);
  v_ms      integer := greatest(coalesce((p_event->>'latency_ms')::integer, 0), 0);
  v_status  text := coalesce(p_event->>'status', 'ok');
  v_by      text := p_event->>'served_by';
  v_cost    numeric := 0;
  v_day     date := (now() at time zone 'utc')::date;
  v_before  numeric;
  v_after   numeric;
  v_alerts  jsonb := '[]'::jsonb;
  v_t       numeric;
begin
  select * into v_set from aro_cost_settings where id;
  -- What it cost *us*. Bring-your-own-key calls are paid by the user's key.
  if v_status <> 'cache_hit' then
    if v_by = 'aro' then
      v_cost := v_ms / 1000.0 * v_set.gpu_usd_per_second;
    elsif v_by = 'fallback' then
      v_cost := (v_in * v_set.fallback_usd_per_mtok_in + v_out * v_set.fallback_usd_per_mtok_out) / 1e6;
    end if;
  end if;

  insert into aro_usage_events (trace_id, user_id, surface, provider, model, served_by, aro_model,
                                input_tokens, output_tokens, cached_tokens, latency_ms, cost_usd, status)
  values ((p_event->>'trace_id')::uuid, p_event->>'user_id', p_event->>'surface', p_event->>'provider',
          p_event->>'model', v_by, p_event->>'aro_model', v_in, v_out,
          greatest(coalesce((p_event->>'cached_tokens')::integer, 0), 0), v_ms, v_cost, v_status);

  insert into aro_spend_daily (day) values (v_day) on conflict do nothing;
  select cost_usd into v_before from aro_spend_daily where day = v_day for update;
  update aro_spend_daily set cost_usd = cost_usd + v_cost, calls = calls + 1 where day = v_day
  returning cost_usd into v_after;

  if v_cost > 0 and v_set.daily_budget_usd > 0 then
    foreach v_t in array v_set.alert_thresholds loop
      if v_before < v_t * v_set.daily_budget_usd and v_after >= v_t * v_set.daily_budget_usd then
        insert into aro_budget_alerts (day, threshold, spent_usd) values (v_day, v_t, v_after)
        on conflict do nothing;
        if found then
          v_alerts := v_alerts || jsonb_build_object('threshold', v_t, 'spent_usd', round(v_after, 4),
                                                     'budget_usd', v_set.daily_budget_usd);
        end if;
      end if;
    end loop;
  end if;

  return jsonb_build_object('cost_usd', round(v_cost, 6), 'spent_today_usd', round(v_after, 6),
                            'budget_usd', v_set.daily_budget_usd, 'alerts', v_alerts);
end $$;

-- Cached answer for a key, or null (missing, expired, or caching turned off).
create or replace function public.aro_cache_get(p_key text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_ttl      integer;
  v_response text;
begin
  select cache_ttl_seconds into v_ttl from aro_cost_settings where id;
  if coalesce(v_ttl, 0) = 0 then return null; end if;
  update aro_response_cache set hits = hits + 1
   where key = p_key and created_at > now() - make_interval(secs => v_ttl)
  returning response into v_response;
  return v_response;
end $$;

create or replace function public.aro_cache_put(p_key text, p_model text, p_response text)
returns void
language plpgsql
set search_path = public
as $$
declare v_ttl integer;
begin
  select cache_ttl_seconds into v_ttl from aro_cost_settings where id;
  if coalesce(v_ttl, 0) = 0 or length(p_response) = 0 or length(p_response) > 20000 then return; end if;
  insert into aro_response_cache (key, model, response) values (p_key, p_model, p_response)
  on conflict (key) do update set response = excluded.response, created_at = now(), hits = 0;
  -- Keep the table small: drop expired entries now and then.
  if random() < 0.02 then
    delete from aro_response_cache where created_at < now() - make_interval(secs => v_ttl);
  end if;
end $$;

-- ------------------------------------------------------------- admin

-- Spend per day, per model and the heaviest users over the last p_days days.
create or replace function public.aro_admin_costs(p_days integer default 7)
returns jsonb language sql stable set search_path = public as $$
  with since as (select (now() at time zone 'utc')::date - greatest(1, least(p_days, 365)) + 1 as day)
  select jsonb_build_object(
    'settings', (select to_jsonb(s) - 'id' from aro_cost_settings s where id),
    'today', coalesce((select to_jsonb(d) from aro_spend_daily d where day = (now() at time zone 'utc')::date),
                      jsonb_build_object('cost_usd', 0, 'calls', 0)),
    'days', coalesce((select jsonb_agg(to_jsonb(d) order by d.day desc)
                        from aro_spend_daily d where d.day >= (select day from since)), '[]'::jsonb),
    'models', coalesce((select jsonb_agg(to_jsonb(m) order by m.cost_usd desc) from (
        select coalesce(aro_model, model) as model, served_by, count(*)::integer as calls,
               sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
               round(sum(cost_usd), 4) as cost_usd, round(avg(latency_ms))::integer as avg_latency_ms,
               count(*) filter (where status = 'cache_hit')::integer as cache_hits
          from aro_usage_events
         where created_at >= (select day from since)
         group by 1, 2) m), '[]'::jsonb),
    'top_users', coalesce((select jsonb_agg(to_jsonb(u) order by u.cost_usd desc) from (
        select user_id, count(*)::integer as calls, round(sum(cost_usd), 4) as cost_usd,
               sum(input_tokens + output_tokens)::bigint as tokens
          from aro_usage_events
         where created_at >= (select day from since)
         group by user_id order by sum(cost_usd) desc, count(*) desc limit 20) u), '[]'::jsonb),
    'alerts', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc)
                          from aro_budget_alerts a where a.day >= (select day from since)), '[]'::jsonb))
$$;

create or replace function public.aro_admin_update_cost_settings(p_admin text, p_patch jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_row aro_cost_settings;
begin
  update aro_cost_settings set
    daily_budget_usd          = coalesce((p_patch->>'daily_budget_usd')::numeric, daily_budget_usd),
    hard_budget_usd           = coalesce((p_patch->>'hard_budget_usd')::numeric, hard_budget_usd),
    gpu_usd_per_second        = coalesce((p_patch->>'gpu_usd_per_second')::numeric, gpu_usd_per_second),
    fallback_usd_per_mtok_in  = coalesce((p_patch->>'fallback_usd_per_mtok_in')::numeric, fallback_usd_per_mtok_in),
    fallback_usd_per_mtok_out = coalesce((p_patch->>'fallback_usd_per_mtok_out')::numeric, fallback_usd_per_mtok_out),
    cache_ttl_seconds         = coalesce((p_patch->>'cache_ttl_seconds')::integer, cache_ttl_seconds),
    alert_thresholds          = coalesce((select array_agg(x::numeric) from jsonb_array_elements_text(p_patch->'alert_thresholds') x),
                                         alert_thresholds),
    updated_at                = now()
  where id
  returning * into v_row;
  if coalesce((p_patch->>'cache_ttl_seconds')::integer, 1) = 0 then
    delete from aro_response_cache;
  end if;
  perform aro_audit(p_admin, 'update_cost_settings', p_patch);
  return to_jsonb(v_row) - 'id';
end $$;

-- Same as before, plus the guardrail columns.
create or replace function public.aro_admin_upsert_plan(p_admin text, p_plan jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_row aro_plans;
begin
  -- Existing plan: change only the fields sent. New plan: name is required.
  update aro_plans set
    name                = coalesce(p_plan->>'name', name),
    price_minor         = coalesce((p_plan->>'price_minor')::integer, price_minor),
    currency            = coalesce(p_plan->>'currency', currency),
    priority            = coalesce((p_plan->>'priority')::integer, priority),
    active              = coalesce((p_plan->>'active')::boolean, active),
    sort                = coalesce((p_plan->>'sort')::integer, sort),
    requests_per_minute = coalesce((p_plan->>'requests_per_minute')::integer, requests_per_minute),
    requests_per_hour   = coalesce((p_plan->>'requests_per_hour')::integer, requests_per_hour),
    max_output_tokens   = coalesce((p_plan->>'max_output_tokens')::integer, max_output_tokens),
    agent_max_steps     = coalesce((p_plan->>'agent_max_steps')::integer, agent_max_steps),
    agent_max_tokens    = coalesce((p_plan->>'agent_max_tokens')::integer, agent_max_tokens),
    updated_at          = now()
  where id = p_plan->>'id'
  returning * into v_row;
  if not found then
    insert into aro_plans (id, name, price_minor, currency, priority, active, sort)
    values (p_plan->>'id', p_plan->>'name', coalesce((p_plan->>'price_minor')::integer, 0),
            coalesce(p_plan->>'currency', 'NGN'), coalesce((p_plan->>'priority')::integer, 0),
            coalesce((p_plan->>'active')::boolean, true), coalesce((p_plan->>'sort')::integer, 0))
    returning * into v_row;
    update aro_plans set
      requests_per_minute = coalesce((p_plan->>'requests_per_minute')::integer, requests_per_minute),
      requests_per_hour   = coalesce((p_plan->>'requests_per_hour')::integer, requests_per_hour),
      max_output_tokens   = coalesce((p_plan->>'max_output_tokens')::integer, max_output_tokens),
      agent_max_steps     = coalesce((p_plan->>'agent_max_steps')::integer, agent_max_steps),
      agent_max_tokens    = coalesce((p_plan->>'agent_max_tokens')::integer, agent_max_tokens)
    where id = v_row.id
    returning * into v_row;
  end if;
  perform aro_audit(p_admin, 'upsert_plan', p_plan);
  return to_jsonb(v_row);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'aro_gate(text, boolean)', 'aro_log_usage(jsonb)', 'aro_cache_get(text)', 'aro_cache_put(text, text, text)',
    'aro_admin_costs(integer)', 'aro_admin_update_cost_settings(text, jsonb)', 'aro_admin_upsert_plan(text, jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
