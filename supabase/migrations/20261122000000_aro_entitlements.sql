-- ARO AI — model catalogue, plans, entitlements, usage, credits and purchases.
--
-- Security model: Row Level Security is ON for every table and there are NO
-- policies, and the functions are only executable by service_role. So the
-- anon/authenticated keys shipped in the app can't read or change any of
-- this — paid access is enforced only by the Edge Functions (service role).

-- ------------------------------------------------------------- catalogue

create table public.aro_models (
  id              text primary key,
  name            text not null,
  tagline         text not null default '',
  status          text not null default 'planned'
                  check (status in ('live', 'preview', 'planned', 'disabled')),
  chat_selectable boolean not null default false,
  served_name     text,
  endpoint        text not null default 'text' check (endpoint in ('text', 'vision', 'voice', 'creative')),
  system_prompt   text not null default '',
  -- Credits charged per request when the plan doesn't cover it (0 = can't buy with credits).
  credit_cost     integer not null default 1 check (credit_cost >= 0),
  sort            integer not null default 0,
  updated_at      timestamptz not null default now()
);

create table public.aro_plans (
  id          text primary key,           -- 'free', 'pro', 'premium'
  name        text not null,
  price_minor integer not null default 0 check (price_minor >= 0),  -- per month, minor units (kobo, cents)
  currency    text not null default 'NGN',
  priority    integer not null default 0, -- higher = served first when capacity is short
  active      boolean not null default true,
  sort        integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Which models a plan includes, and how many requests per day (NULL = no daily cap).
create table public.aro_plan_models (
  plan_id           text not null references public.aro_plans (id) on delete cascade,
  model_id          text not null references public.aro_models (id) on delete cascade,
  daily_limit       integer check (daily_limit is null or daily_limit >= 0),
  max_output_tokens integer check (max_output_tokens is null or max_output_tokens > 0),
  primary key (plan_id, model_id)
);

-- Individual model purchases (e.g. "ARO Code, 30 days").
create table public.aro_model_products (
  id            text primary key,
  model_id      text not null references public.aro_models (id) on delete cascade,
  name          text not null,
  price_minor   integer not null check (price_minor >= 0),
  currency      text not null default 'NGN',
  duration_days integer not null check (duration_days > 0),
  daily_limit   integer check (daily_limit is null or daily_limit >= 0),
  active        boolean not null default true
);

create table public.aro_credit_packs (
  id          text primary key,
  name        text not null,
  credits     integer not null check (credits > 0),
  price_minor integer not null check (price_minor >= 0),
  currency    text not null default 'NGN',
  active      boolean not null default true
);

-- --------------------------------------------------------- per user

-- user_id is the Firebase Auth uid.
create table public.aro_user_plans (
  user_id    text primary key,
  plan_id    text not null references public.aro_plans (id),
  expires_at timestamptz,                 -- NULL = doesn't expire
  source     text not null default 'admin',
  updated_at timestamptz not null default now()
);

create table public.aro_user_model_grants (
  user_id     text not null,
  model_id    text not null references public.aro_models (id) on delete cascade,
  daily_limit integer check (daily_limit is null or daily_limit >= 0),
  expires_at  timestamptz,
  source      text not null default 'purchase',
  primary key (user_id, model_id)
);

create table public.aro_credit_balances (
  user_id    text primary key,
  balance    integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table public.aro_credit_ledger (
  id         bigint generated always as identity primary key,
  user_id    text not null,
  delta      integer not null,
  reason     text not null,
  model_id   text,
  ref        text,
  created_at timestamptz not null default now()
);
create index aro_credit_ledger_user on public.aro_credit_ledger (user_id, created_at desc);

create table public.aro_usage_daily (
  user_id       text not null,
  model_id      text not null,
  day           date not null,
  requests      integer not null default 0 check (requests >= 0),
  credits_spent integer not null default 0 check (credits_spent >= 0),
  primary key (user_id, model_id, day)
);
create index aro_usage_daily_day on public.aro_usage_daily (day, model_id);

create table public.aro_admin_audit (
  id         bigint generated always as identity primary key,
  admin_uid  text not null,
  action     text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Written by training/aro_training/evaluate.py; shown in the admin dashboard.
create table public.model_evaluations (
  id              bigint generated always as identity primary key,
  model_id        text not null,
  candidate       text not null,
  promoted        boolean not null,
  reason          text not null default '',
  candidate_score numeric not null,
  current_score   numeric not null,
  metrics         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index model_evaluations_model on public.model_evaluations (model_id, created_at desc);

-- ---------------------------------------------------------- lock down

do $$
declare t text;
begin
  foreach t in array array[
    'aro_models', 'aro_plans', 'aro_plan_models', 'aro_model_products', 'aro_credit_packs',
    'aro_user_plans', 'aro_user_model_grants', 'aro_credit_balances', 'aro_credit_ledger',
    'aro_usage_daily', 'aro_admin_audit', 'model_evaluations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ------------------------------------------------------------ functions

-- The user's current plan id ('free' when none or expired).
create or replace function public.aro_current_plan(p_user text)
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select up.plan_id
       from aro_user_plans up
       join aro_plans p on p.id = up.plan_id and p.active
      where up.user_id = p_user and (up.expires_at is null or up.expires_at > now())),
    'free')
$$;

-- Checks (and, when p_consume, records) one request by p_user to p_model.
-- Order: plan or purchased grant within its daily limit → else credits → else denied.
-- Returns jsonb: {allowed, via, reason?, plan, limit, used, remaining, credits, model{...}}.
create or replace function public.aro_authorize(p_user text, p_model text, p_consume boolean default true)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_model    aro_models;
  v_plan     text := aro_current_plan(p_user);
  v_has_plan boolean := false;
  v_plan_lim integer;
  v_has_gr   boolean := false;
  v_gr_lim   integer;
  v_access   boolean;
  v_limit    integer;
  v_via      text;
  v_used     integer;
  v_balance  integer;
  v_today    date := (now() at time zone 'utc')::date;
  v_info     jsonb;
begin
  select * into v_model from aro_models where id = p_model;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_model');
  end if;
  v_info := jsonb_build_object(
    'id', v_model.id, 'name', v_model.name, 'status', v_model.status, 'served_name', v_model.served_name,
    'endpoint', v_model.endpoint, 'system_prompt', v_model.system_prompt, 'credit_cost', v_model.credit_cost);
  if v_model.status in ('planned', 'disabled') then
    return jsonb_build_object('allowed', false, 'reason', 'model_unavailable', 'plan', v_plan, 'model', v_info);
  end if;

  select true, pm.daily_limit into v_has_plan, v_plan_lim
    from aro_plan_models pm where pm.plan_id = v_plan and pm.model_id = p_model;
  v_has_plan := coalesce(v_has_plan, false);
  select true, g.daily_limit into v_has_gr, v_gr_lim
    from aro_user_model_grants g
   where g.user_id = p_user and g.model_id = p_model and (g.expires_at is null or g.expires_at > now());
  v_has_gr := coalesce(v_has_gr, false);

  v_access := v_has_plan or v_has_gr;
  -- The more generous of plan and purchase wins (NULL = no daily cap).
  if v_has_gr and (not v_has_plan or v_gr_lim is null or (v_plan_lim is not null and v_gr_lim > v_plan_lim)) then
    v_limit := v_gr_lim; v_via := 'purchase';
  elsif v_has_plan then
    v_limit := v_plan_lim; v_via := 'plan';
  end if;

  insert into aro_usage_daily (user_id, model_id, day) values (p_user, p_model, v_today)
  on conflict do nothing;
  select requests into v_used from aro_usage_daily
   where user_id = p_user and model_id = p_model and day = v_today
   for update;                                     -- serialises concurrent requests

  if v_access and (v_limit is null or v_used < v_limit) then
    if p_consume then
      update aro_usage_daily set requests = requests + 1
       where user_id = p_user and model_id = p_model and day = v_today;
      v_used := v_used + 1;
    end if;
    return jsonb_build_object(
      'allowed', true, 'via', v_via, 'plan', v_plan, 'limit', v_limit, 'used', v_used,
      'remaining', case when v_limit is null then null else greatest(v_limit - v_used, 0) end,
      'model', v_info);
  end if;

  -- Not covered (or the daily limit is used up): pay with credits if possible.
  select balance into v_balance from aro_credit_balances where user_id = p_user for update;
  v_balance := coalesce(v_balance, 0);
  if v_model.credit_cost > 0 and v_balance >= v_model.credit_cost then
    if p_consume then
      update aro_credit_balances set balance = balance - v_model.credit_cost, updated_at = now()
       where user_id = p_user;
      insert into aro_credit_ledger (user_id, delta, reason, model_id)
      values (p_user, -v_model.credit_cost, 'usage', p_model);
      update aro_usage_daily set requests = requests + 1, credits_spent = credits_spent + v_model.credit_cost
       where user_id = p_user and model_id = p_model and day = v_today;
      v_balance := v_balance - v_model.credit_cost;
    end if;
    return jsonb_build_object('allowed', true, 'via', 'credits', 'plan', v_plan, 'credits', v_balance,
                              'used', v_used + case when p_consume then 1 else 0 end, 'model', v_info);
  end if;

  return jsonb_build_object(
    'allowed', false,
    'reason', case when v_access then 'daily_limit_reached' else 'upgrade_required' end,
    'plan', v_plan, 'limit', v_limit, 'used', v_used, 'credits', v_balance,
    'upgrade_plans', coalesce((
      select jsonb_agg(p.id order by p.sort)
        from aro_plan_models pm join aro_plans p on p.id = pm.plan_id and p.active
       where pm.model_id = p_model and pm.plan_id <> v_plan
         and (pm.daily_limit is null or pm.daily_limit > coalesce(v_limit, 0))), '[]'::jsonb),
    'model', v_info);
end $$;

-- Gives back a request (and its credits) when the model failed before answering.
create or replace function public.aro_refund(p_user text, p_model text, p_via text)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_cost  integer;
begin
  update aro_usage_daily set requests = greatest(requests - 1, 0)
   where user_id = p_user and model_id = p_model and day = v_today;
  if p_via = 'credits' then
    select credit_cost into v_cost from aro_models where id = p_model;
    if coalesce(v_cost, 0) > 0 then
      update aro_usage_daily set credits_spent = greatest(credits_spent - v_cost, 0)
       where user_id = p_user and model_id = p_model and day = v_today;
      perform aro_add_credits(p_user, v_cost, 'refund', p_model);
    end if;
  end if;
end $$;

-- Adds (or with a negative amount, removes) credits, always through the ledger.
create or replace function public.aro_add_credits(p_user text, p_amount integer, p_reason text, p_ref text default null)
returns integer
language plpgsql
set search_path = public
as $$
declare v_balance integer;
begin
  insert into aro_credit_balances (user_id, balance) values (p_user, 0) on conflict do nothing;
  update aro_credit_balances set balance = balance + p_amount, updated_at = now()
   where user_id = p_user
   returning balance into v_balance;                -- CHECK (balance >= 0) rejects overdrafts
  insert into aro_credit_ledger (user_id, delta, reason, ref) values (p_user, p_amount, p_reason, p_ref);
  return v_balance;
end $$;

-- Everything the app's "Models & Plan" screen shows, for one user.
create or replace function public.aro_user_overview(p_user text)
returns jsonb
language sql
stable
set search_path = public
as $$
  with plan as (select aro_current_plan(p_user) as id),
  today as (select (now() at time zone 'utc')::date as day)
  select jsonb_build_object(
    'plan', (select jsonb_build_object('id', p.id, 'name', p.name,
                     'expires_at', (select expires_at from aro_user_plans where user_id = p_user and plan_id = p.id))
               from aro_plans p where p.id = (select id from plan)),
    'credits', coalesce((select balance from aro_credit_balances where user_id = p_user), 0),
    'models', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'tagline', m.tagline, 'status', m.status,
        'chat_selectable', m.chat_selectable, 'credit_cost', m.credit_cost,
        'included', pm.model_id is not null or g.model_id is not null,
        'daily_limit', case when g.model_id is not null and (pm.model_id is null or g.daily_limit is null or g.daily_limit > pm.daily_limit)
                            then g.daily_limit else pm.daily_limit end,
        'purchase_expires_at', g.expires_at,
        'used_today', coalesce(u.requests, 0)) order by m.sort)
      from aro_models m
      left join aro_plan_models pm on pm.model_id = m.id and pm.plan_id = (select id from plan)
      left join aro_user_model_grants g on g.model_id = m.id and g.user_id = p_user
                                        and (g.expires_at is null or g.expires_at > now())
      left join aro_usage_daily u on u.model_id = m.id and u.user_id = p_user and u.day = (select day from today)
      where m.status <> 'disabled'), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'price_minor', p.price_minor, 'currency', p.currency,
        'models', coalesce((select jsonb_object_agg(pm.model_id, pm.daily_limit) from aro_plan_models pm where pm.plan_id = p.id), '{}'::jsonb))
        order by p.sort)
      from aro_plans p where p.active), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(x) order by x.price_minor) from aro_model_products x where x.active), '[]'::jsonb),
    'credit_packs', coalesce((select jsonb_agg(to_jsonb(c) order by c.credits) from aro_credit_packs c where c.active), '[]'::jsonb))
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'aro_current_plan(text)', 'aro_authorize(text, text, boolean)', 'aro_refund(text, text, text)',
    'aro_add_credits(text, integer, text, text)', 'aro_user_overview(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
