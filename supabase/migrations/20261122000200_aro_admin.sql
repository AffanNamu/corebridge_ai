-- ARO AI — admin operations used by the aro-admin Edge Function.
-- Every change is written to aro_admin_audit. Callable by service_role only.
-- p_admin is the admin's Firebase uid (or e.g. 'payments:paystack' for a
-- future payment webhook granting plans after a successful charge).

create or replace function public.aro_audit(p_admin text, p_action text, p_payload jsonb)
returns void language sql set search_path = public as $$
  insert into aro_admin_audit (admin_uid, action, payload) values (p_admin, p_action, coalesce(p_payload, '{}'::jsonb))
$$;

create or replace function public.aro_admin_config()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'models',       coalesce((select jsonb_agg(to_jsonb(m) order by m.sort) from aro_models m), '[]'::jsonb),
    'plans',        coalesce((select jsonb_agg(to_jsonb(p) order by p.sort) from aro_plans p), '[]'::jsonb),
    'plan_models',  coalesce((select jsonb_agg(to_jsonb(pm) order by pm.plan_id, pm.model_id) from aro_plan_models pm), '[]'::jsonb),
    'products',     coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from aro_model_products x), '[]'::jsonb),
    'credit_packs', coalesce((select jsonb_agg(to_jsonb(c) order by c.credits) from aro_credit_packs c), '[]'::jsonb))
$$;

create or replace function public.aro_admin_update_model(p_admin text, p_id text, p_patch jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_row aro_models;
begin
  update aro_models set
    name            = coalesce(p_patch->>'name', name),
    tagline         = coalesce(p_patch->>'tagline', tagline),
    status          = coalesce(p_patch->>'status', status),
    chat_selectable = coalesce((p_patch->>'chat_selectable')::boolean, chat_selectable),
    served_name     = coalesce(p_patch->>'served_name', served_name),
    system_prompt   = coalesce(p_patch->>'system_prompt', system_prompt),
    credit_cost     = coalesce((p_patch->>'credit_cost')::integer, credit_cost),
    sort            = coalesce((p_patch->>'sort')::integer, sort),
    updated_at      = now()
  where id = p_id
  returning * into v_row;
  if not found then raise exception 'unknown model %', p_id using errcode = 'P0002'; end if;
  perform aro_audit(p_admin, 'update_model', jsonb_build_object('id', p_id, 'patch', p_patch));
  return to_jsonb(v_row);
end $$;

create or replace function public.aro_admin_upsert_plan(p_admin text, p_plan jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_row aro_plans;
begin
  -- Existing plan: change only the fields sent. New plan: name is required.
  update aro_plans set
    name        = coalesce(p_plan->>'name', name),
    price_minor = coalesce((p_plan->>'price_minor')::integer, price_minor),
    currency    = coalesce(p_plan->>'currency', currency),
    priority    = coalesce((p_plan->>'priority')::integer, priority),
    active      = coalesce((p_plan->>'active')::boolean, active),
    sort        = coalesce((p_plan->>'sort')::integer, sort),
    updated_at  = now()
  where id = p_plan->>'id'
  returning * into v_row;
  if not found then
    insert into aro_plans (id, name, price_minor, currency, priority, active, sort)
    values (p_plan->>'id', p_plan->>'name', coalesce((p_plan->>'price_minor')::integer, 0),
            coalesce(p_plan->>'currency', 'NGN'), coalesce((p_plan->>'priority')::integer, 0),
            coalesce((p_plan->>'active')::boolean, true), coalesce((p_plan->>'sort')::integer, 0))
    returning * into v_row;
  end if;
  perform aro_audit(p_admin, 'upsert_plan', p_plan);
  return to_jsonb(v_row);
end $$;

-- p_included = false removes the model from the plan.
create or replace function public.aro_admin_set_plan_model(
  p_admin text, p_plan text, p_model text, p_included boolean, p_daily_limit integer default null)
returns void language plpgsql set search_path = public as $$
begin
  if p_included then
    insert into aro_plan_models (plan_id, model_id, daily_limit) values (p_plan, p_model, p_daily_limit)
    on conflict (plan_id, model_id) do update set daily_limit = excluded.daily_limit;
  else
    delete from aro_plan_models where plan_id = p_plan and model_id = p_model;
  end if;
  perform aro_audit(p_admin, 'set_plan_model',
    jsonb_build_object('plan', p_plan, 'model', p_model, 'included', p_included, 'daily_limit', p_daily_limit));
end $$;

create or replace function public.aro_admin_upsert_product(p_admin text, p_product jsonb)
returns void language plpgsql set search_path = public as $$
begin
  insert into aro_model_products (id, model_id, name, price_minor, currency, duration_days, daily_limit, active)
  values (p_product->>'id', p_product->>'model_id', p_product->>'name', (p_product->>'price_minor')::integer,
          coalesce(p_product->>'currency', 'NGN'), (p_product->>'duration_days')::integer,
          (p_product->>'daily_limit')::integer, coalesce((p_product->>'active')::boolean, true))
  on conflict (id) do update set
    model_id = excluded.model_id, name = excluded.name, price_minor = excluded.price_minor,
    currency = excluded.currency, duration_days = excluded.duration_days,
    daily_limit = excluded.daily_limit, active = excluded.active;
  perform aro_audit(p_admin, 'upsert_product', p_product);
end $$;

create or replace function public.aro_admin_upsert_credit_pack(p_admin text, p_pack jsonb)
returns void language plpgsql set search_path = public as $$
begin
  insert into aro_credit_packs (id, name, credits, price_minor, currency, active)
  values (p_pack->>'id', p_pack->>'name', (p_pack->>'credits')::integer, (p_pack->>'price_minor')::integer,
          coalesce(p_pack->>'currency', 'NGN'), coalesce((p_pack->>'active')::boolean, true))
  on conflict (id) do update set
    name = excluded.name, credits = excluded.credits, price_minor = excluded.price_minor,
    currency = excluded.currency, active = excluded.active;
  perform aro_audit(p_admin, 'upsert_credit_pack', p_pack);
end $$;

-- p_days NULL = no expiry. Granting 'free' removes a paid plan.
create or replace function public.aro_admin_grant_plan(p_admin text, p_user text, p_plan text, p_days integer default null)
returns jsonb language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from aro_plans where id = p_plan) then
    raise exception 'unknown plan %', p_plan using errcode = 'P0002';
  end if;
  if p_plan = 'free' then
    delete from aro_user_plans where user_id = p_user;
  else
    insert into aro_user_plans (user_id, plan_id, expires_at, source, updated_at)
    values (p_user, p_plan, case when p_days is null then null else now() + make_interval(days => p_days) end, p_admin, now())
    on conflict (user_id) do update set
      plan_id = excluded.plan_id, expires_at = excluded.expires_at, source = excluded.source, updated_at = now();
  end if;
  perform aro_audit(p_admin, 'grant_plan', jsonb_build_object('user', p_user, 'plan', p_plan, 'days', p_days));
  return aro_user_overview(p_user);
end $$;

create or replace function public.aro_admin_grant_model(
  p_admin text, p_user text, p_model text, p_days integer default null, p_daily_limit integer default null)
returns jsonb language plpgsql set search_path = public as $$
begin
  insert into aro_user_model_grants (user_id, model_id, daily_limit, expires_at, source)
  values (p_user, p_model, p_daily_limit,
          case when p_days is null then null else now() + make_interval(days => p_days) end, p_admin)
  on conflict (user_id, model_id) do update set
    daily_limit = excluded.daily_limit, expires_at = excluded.expires_at, source = excluded.source;
  perform aro_audit(p_admin, 'grant_model',
    jsonb_build_object('user', p_user, 'model', p_model, 'days', p_days, 'daily_limit', p_daily_limit));
  return aro_user_overview(p_user);
end $$;

create or replace function public.aro_admin_add_credits(p_admin text, p_user text, p_amount integer, p_reason text default 'admin')
returns integer language plpgsql set search_path = public as $$
declare v_balance integer;
begin
  v_balance := aro_add_credits(p_user, p_amount, p_reason, p_admin);
  perform aro_audit(p_admin, 'add_credits', jsonb_build_object('user', p_user, 'amount', p_amount, 'reason', p_reason));
  return v_balance;
end $$;

-- Requests, users and credits per model over the last p_days days.
create or replace function public.aro_admin_usage(p_days integer default 7)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'model_id', model_id, 'requests', requests, 'users', users, 'credits_spent', credits) order by requests desc), '[]'::jsonb)
  from (
    select model_id, sum(requests)::integer as requests, count(distinct user_id)::integer as users,
           sum(credits_spent)::integer as credits
      from aro_usage_daily
     where day > (now() at time zone 'utc')::date - p_days
     group by model_id) t
$$;

create or replace function public.aro_admin_evaluations(p_model text default null, p_limit integer default 50)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
  from (select * from model_evaluations
         where p_model is null or model_id = p_model
         order by created_at desc limit greatest(1, least(p_limit, 500))) e
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'aro_audit(text, text, jsonb)', 'aro_admin_config()', 'aro_admin_update_model(text, text, jsonb)',
    'aro_admin_upsert_plan(text, jsonb)', 'aro_admin_set_plan_model(text, text, text, boolean, integer)',
    'aro_admin_upsert_product(text, jsonb)', 'aro_admin_upsert_credit_pack(text, jsonb)',
    'aro_admin_grant_plan(text, text, text, integer)', 'aro_admin_grant_model(text, text, text, integer, integer)',
    'aro_admin_add_credits(text, text, integer, text)', 'aro_admin_usage(integer)', 'aro_admin_evaluations(text, integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
