// aro-admin: the admin dashboard's API. Only Firebase users listed in the
// ADMIN_UIDS secret may call it. Every change goes through an audited
// Postgres function (supabase/migrations/*_aro_admin.sql).
//
// Request body (POST, JSON): { action, ...params }
//   config                                         models, plans, limits, products, credit packs
//   updateModel     { id, patch: { status?, name?, tagline?, chat_selectable?, credit_cost?, ... } }
//   upsertPlan      { plan: { id, name?, price_minor?, currency?, priority?, active?, sort?,
//                             requests_per_minute?, requests_per_hour?, max_output_tokens?,
//                             agent_max_steps?, agent_max_tokens? } }
//   setPlanModel    { planId, modelId, included, dailyLimit? (null = no cap) }
//   upsertProduct   { product: { id, model_id, name, price_minor, duration_days, daily_limit?, active? } }
//   upsertCreditPack{ pack: { id, name, credits, price_minor, active? } }
//   grantPlan       { userId, planId, days? }
//   grantModel      { userId, modelId, days?, dailyLimit? }
//   addCredits      { userId, amount, reason? }
//   userOverview    { userId }
//   usage           { days? }
//   evaluations     { modelId?, limit? }
//   costs           { days? }                       GPU spend per day/model, top users, budget alerts
//   updateCostSettings { patch: { daily_budget_usd?, hard_budget_usd?, alert_thresholds?,
//                                 gpu_usd_per_second?, fallback_usd_per_mtok_in?, fallback_usd_per_mtok_out?,
//                                 cache_ttl_seconds? } }

import { type Db, dbFromEnv } from '../_shared/db.ts';
import { isAdmin } from '../_shared/entitlements.ts';
import type { VerifiedUser } from '../_shared/firebase-auth.ts';
import { CORS_HEADERS, errorResponse, jsonResponse } from '../_shared/http.ts';

export interface AdminDeps {
  verify: (req: Request) => Promise<VerifiedUser | null>;
  env?: (name: string) => string | undefined;
  db?: Db | null;
}

class BadRequest extends Error {}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USER = /^[A-Za-z0-9_-]{6,128}$/; // Firebase uids
const STATUSES = new Set(['live', 'preview', 'planned', 'disabled']);

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new BadRequest(`Invalid ${field}`);
  return value;
}

function userId(value: unknown): string {
  if (typeof value !== 'string' || !USER.test(value)) throw new BadRequest('Invalid userId (use the Firebase uid)');
  return value;
}

function int(value: unknown, field: string, { min = 0, max = 1_000_000_000, nullable = false } = {}): number | null {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null;
    throw new BadRequest(`Missing ${field}`);
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new BadRequest(`Invalid ${field}`);
  return n;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequest(`Missing ${field}`);
  return value as Record<string, unknown>;
}

function modelPatch(raw: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ('status' in raw) {
    if (!STATUSES.has(String(raw.status))) throw new BadRequest('status must be live, preview, planned or disabled');
    patch.status = raw.status;
  }
  for (const key of ['name', 'tagline', 'served_name', 'system_prompt']) {
    if (key in raw) {
      if (typeof raw[key] !== 'string' || (raw[key] as string).length > 4000) throw new BadRequest(`Invalid ${key}`);
      patch[key] = raw[key];
    }
  }
  if ('chat_selectable' in raw) patch.chat_selectable = raw.chat_selectable === true;
  if ('credit_cost' in raw) patch.credit_cost = int(raw.credit_cost, 'credit_cost', { max: 100_000 });
  if ('sort' in raw) patch.sort = int(raw.sort, 'sort', { max: 1000 });
  if (Object.keys(patch).length === 0) throw new BadRequest('Nothing to change');
  return patch;
}

function money(value: unknown, field: string, max: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) throw new BadRequest(`Invalid ${field}`);
  return n;
}

function costPatch(raw: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ('daily_budget_usd' in raw) patch.daily_budget_usd = money(raw.daily_budget_usd, 'daily_budget_usd', 100_000);
  if ('hard_budget_usd' in raw) patch.hard_budget_usd = money(raw.hard_budget_usd, 'hard_budget_usd', 100_000);
  if ('gpu_usd_per_second' in raw) patch.gpu_usd_per_second = money(raw.gpu_usd_per_second, 'gpu_usd_per_second', 1);
  for (const key of ['fallback_usd_per_mtok_in', 'fallback_usd_per_mtok_out']) {
    if (key in raw) patch[key] = money(raw[key], key, 1_000);
  }
  if ('cache_ttl_seconds' in raw) patch.cache_ttl_seconds = int(raw.cache_ttl_seconds, 'cache_ttl_seconds', { max: 7 * 86_400 });
  if ('alert_thresholds' in raw) {
    const list = raw.alert_thresholds;
    if (!Array.isArray(list) || list.length > 10 || list.some((t) => typeof t !== 'number' || t <= 0 || t > 10)) {
      throw new BadRequest('alert_thresholds must be up to 10 fractions of the budget, e.g. [0.5, 0.8, 1]');
    }
    patch.alert_thresholds = list;
  }
  const daily = patch.daily_budget_usd as number | undefined;
  const hard = patch.hard_budget_usd as number | undefined;
  if (daily !== undefined && hard !== undefined && hard < daily) throw new BadRequest('hard_budget_usd must be at least daily_budget_usd');
  if (Object.keys(patch).length === 0) throw new BadRequest('Nothing to change');
  return patch;
}

async function run(db: Db, admin: string, body: Record<string, unknown>): Promise<unknown> {
  switch (body.action) {
    case 'config':
      return db.rpc('aro_admin_config', {});
    case 'updateModel':
      return db.rpc('aro_admin_update_model', {
        p_admin: admin, p_id: id(body.id, 'id'), p_patch: modelPatch(object(body.patch, 'patch')),
      });
    case 'upsertPlan': {
      const plan = object(body.plan, 'plan');
      const clean: Record<string, unknown> = { id: id(plan.id, 'plan id') };
      if ('name' in plan) clean.name = String(plan.name).slice(0, 80);
      if ('price_minor' in plan) clean.price_minor = int(plan.price_minor, 'price_minor');
      if ('currency' in plan) clean.currency = String(plan.currency).toUpperCase().slice(0, 3);
      if ('priority' in plan) clean.priority = int(plan.priority, 'priority', { max: 1000 });
      if ('active' in plan) clean.active = plan.active === true;
      if ('sort' in plan) clean.sort = int(plan.sort, 'sort', { max: 1000 });
      const guardrails: [string, number, number][] = [
        ['requests_per_minute', 1, 10_000], ['requests_per_hour', 1, 1_000_000], ['max_output_tokens', 64, 32_768],
        ['agent_max_steps', 1, 200], ['agent_max_tokens', 1_000, 100_000_000],
      ];
      for (const [key, min, max] of guardrails) {
        if (key in plan) clean[key] = int(plan[key], key, { min, max });
      }
      return db.rpc('aro_admin_upsert_plan', { p_admin: admin, p_plan: clean });
    }
    case 'setPlanModel':
      await db.rpc('aro_admin_set_plan_model', {
        p_admin: admin,
        p_plan: id(body.planId, 'planId'),
        p_model: id(body.modelId, 'modelId'),
        p_included: body.included === true,
        p_daily_limit: int(body.dailyLimit, 'dailyLimit', { nullable: true, max: 1_000_000 }),
      });
      return { ok: true };
    case 'upsertProduct': {
      const p = object(body.product, 'product');
      await db.rpc('aro_admin_upsert_product', {
        p_admin: admin,
        p_product: {
          id: id(p.id, 'product id'), model_id: id(p.model_id, 'model_id'), name: String(p.name ?? '').slice(0, 120),
          price_minor: int(p.price_minor, 'price_minor'), currency: String(p.currency ?? 'NGN').slice(0, 3),
          duration_days: int(p.duration_days, 'duration_days', { min: 1, max: 3660 }),
          daily_limit: int(p.daily_limit, 'daily_limit', { nullable: true }), active: p.active !== false,
        },
      });
      return { ok: true };
    }
    case 'upsertCreditPack': {
      const p = object(body.pack, 'pack');
      await db.rpc('aro_admin_upsert_credit_pack', {
        p_admin: admin,
        p_pack: {
          id: id(p.id, 'pack id'), name: String(p.name ?? '').slice(0, 120), credits: int(p.credits, 'credits', { min: 1 }),
          price_minor: int(p.price_minor, 'price_minor'), currency: String(p.currency ?? 'NGN').slice(0, 3),
          active: p.active !== false,
        },
      });
      return { ok: true };
    }
    case 'grantPlan':
      return db.rpc('aro_admin_grant_plan', {
        p_admin: admin, p_user: userId(body.userId), p_plan: id(body.planId, 'planId'),
        p_days: int(body.days, 'days', { nullable: true, min: 1, max: 3660 }),
      });
    case 'grantModel':
      return db.rpc('aro_admin_grant_model', {
        p_admin: admin, p_user: userId(body.userId), p_model: id(body.modelId, 'modelId'),
        p_days: int(body.days, 'days', { nullable: true, min: 1, max: 3660 }),
        p_daily_limit: int(body.dailyLimit, 'dailyLimit', { nullable: true }),
      });
    case 'addCredits':
      return {
        balance: await db.rpc('aro_admin_add_credits', {
          p_admin: admin, p_user: userId(body.userId),
          p_amount: int(body.amount, 'amount', { min: -1_000_000, max: 1_000_000 }),
          p_reason: String(body.reason ?? 'admin').slice(0, 200),
        }),
      };
    case 'userOverview':
      return db.rpc('aro_user_overview', { p_user: userId(body.userId) });
    case 'usage':
      return db.rpc('aro_admin_usage', { p_days: int(body.days ?? 7, 'days', { min: 1, max: 365 }) });
    case 'evaluations':
      return db.rpc('aro_admin_evaluations', {
        p_model: body.modelId ? id(body.modelId, 'modelId') : null,
        p_limit: int(body.limit ?? 50, 'limit', { min: 1, max: 500 }),
      });
    case 'costs':
      return db.rpc('aro_admin_costs', { p_days: int(body.days ?? 7, 'days', { min: 1, max: 365 }) });
    case 'updateCostSettings':
      return db.rpc('aro_admin_update_cost_settings', { p_admin: admin, p_patch: costPatch(object(body.patch, 'patch')) });
    default:
      throw new BadRequest('Unknown action');
  }
}

export async function handleRequest(req: Request, deps: AdminDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  const user = await deps.verify(req);
  if (!user) return errorResponse('Unauthorized', 401);
  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  if (!isAdmin(user.uid, env)) return errorResponse('Admins only', 403);

  const db = deps.db === undefined ? dbFromEnv(env) : deps.db;
  if (!db) return errorResponse("The database isn't configured.", 503);

  let body: Record<string, unknown>;
  try {
    body = object(await req.json(), 'body');
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  try {
    return jsonResponse(await run(db, user.uid, body) ?? { ok: true });
  } catch (err) {
    if (err instanceof BadRequest) return errorResponse(err.message, 400);
    const message = err instanceof Error ? err.message : 'Database error';
    console.error('aro-admin:', message);
    return errorResponse(message.includes('unknown') ? message : 'The change could not be saved.', message.includes('unknown') ? 404 : 500);
  }
}
