import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@1';
import { authorize, denialMessage, isAdmin, overview, refund } from '../_shared/entitlements.ts';
import { testDb } from './pg.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ name: 'seed: the seven capability entries and three plans from the catalogue', ...opts, fn: async () => {
  const db = await testDb();
  const models = await db.sql<{ id: string; status: string }>('select id, status from aro_models order by sort');
  assertEquals(models.map((m) => m.id), ['aro-1.5', 'aro-code', 'aro-research', 'aro-vision', 'aro-voice', 'aro-creative', 'aro-translate']);
  assertEquals(models[0].status, 'live');
  const plans = await db.sql<{ id: string }>('select id from aro_plans order by sort');
  assertEquals(plans.map((p) => p.id), ['free', 'pro', 'premium']);
} });

Deno.test({ name: 'free plan: ARO 1.5 within the daily limit, then denied with an upgrade path', ...opts, fn: async () => {
  const db = await testDb();
  await db.sql("update aro_plan_models set daily_limit = 2 where plan_id = 'free' and model_id = 'aro-1.5'");
  const a = await authorize(db, 'u1', 'aro-1.5');
  assertEquals([a.allowed, a.via, a.plan, a.used, a.remaining], [true, 'plan', 'free', 1, 1]);
  assertEquals(a.model?.served_name, 'aro-1.5');
  assertStringIncludes(a.model?.system_prompt ?? '', 'ARO 1.5');
  assert((await authorize(db, 'u1', 'aro-1.5')).allowed);
  const denied = await authorize(db, 'u1', 'aro-1.5');
  assertEquals([denied.allowed, denied.reason], [false, 'daily_limit_reached']);
  assertEquals(denied.upgrade_plans, ['pro', 'premium']);
  assertStringIncludes(denialMessage(denied, 'ARO 1.5'), 'used all 2 ARO 1.5 requests');
  // Another user is unaffected.
  assert((await authorize(db, 'u2', 'aro-1.5')).allowed);
} });

Deno.test({ name: 'checking without consuming does not use up the allowance', ...opts, fn: async () => {
  const db = await testDb();
  await authorize(db, 'u1', 'aro-1.5', false);
  await authorize(db, 'u1', 'aro-1.5', false);
  assertEquals((await authorize(db, 'u1', 'aro-1.5')).used, 1);
} });

Deno.test({ name: "free users need Pro (or a purchase, or credits) for ARO 1.5's coding capability", ...opts, fn: async () => {
  const db = await testDb();
  const denied = await authorize(db, 'u1', 'aro-code');
  assertEquals([denied.allowed, denied.reason], [false, 'upgrade_required']);
  assertEquals(denied.upgrade_plans, ['pro', 'premium']);
  assertStringIncludes(denialMessage(denied, 'ARO 1.5 · Code'), "isn't included in Free. It's included in Pro and Premium.");

  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: 'u1', p_plan: 'pro', p_days: 30 });
  const ok = await authorize(db, 'u1', 'aro-code');
  assertEquals([ok.allowed, ok.via, ok.plan, ok.limit], [true, 'plan', 'pro', 200]);
} });

Deno.test({ name: 'an individual model purchase unlocks one model', ...opts, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_grant_model', { p_admin: 'payments:test', p_user: 'u1', p_model: 'aro-research', p_days: 30, p_daily_limit: 100 });
  const ok = await authorize(db, 'u1', 'aro-research');
  assertEquals([ok.allowed, ok.via, ok.limit], [true, 'purchase', 100]);
  assertEquals((await authorize(db, 'u1', 'aro-code')).allowed, false);
} });

Deno.test({ name: 'credits pay when the plan does not cover it, and are refunded on failure', ...opts, fn: async () => {
  const db = await testDb();
  assertEquals(await db.rpc('aro_admin_add_credits', { p_admin: 'admin', p_user: 'u1', p_amount: 5, p_reason: 'test' }), 5);
  const a = await authorize(db, 'u1', 'aro-code'); // costs 2
  assertEquals([a.allowed, a.via, a.credits], [true, 'credits', 3]);
  await refund(db, 'u1', 'aro-code', 'credits');
  const balance = await db.sql<{ balance: number }>("select balance from aro_credit_balances where user_id = 'u1'");
  assertEquals(balance[0].balance, 5);
  const ledger = await db.sql<{ delta: number; reason: string }>("select delta, reason from aro_credit_ledger where user_id = 'u1' order by id");
  assertEquals(ledger.map((l) => [l.delta, l.reason]), [[5, 'test'], [-2, 'usage'], [2, 'refund']]);

  await authorize(db, 'u1', 'aro-code');
  await authorize(db, 'u1', 'aro-code');
  const broke = await authorize(db, 'u1', 'aro-code'); // 1 credit left, costs 2
  assertEquals([broke.allowed, broke.reason, broke.credits], [false, 'upgrade_required', 1]);
} });

Deno.test({ name: 'credits can never go negative', ...opts, fn: async () => {
  const db = await testDb();
  await assertRejects(() => db.rpc('aro_admin_add_credits', { p_admin: 'admin', p_user: 'u1', p_amount: -1, p_reason: 'x' }));
} });

Deno.test({ name: 'plan refund gives the request back', ...opts, fn: async () => {
  const db = await testDb();
  await authorize(db, 'u1', 'aro-1.5');
  await refund(db, 'u1', 'aro-1.5', 'plan');
  assertEquals((await authorize(db, 'u1', 'aro-1.5')).used, 1);
} });

Deno.test({ name: 'expired plans fall back to free', ...opts, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: 'u1', p_plan: 'premium', p_days: 30 });
  await db.sql("update aro_user_plans set expires_at = now() - interval '1 day' where user_id = 'u1'");
  const a = await authorize(db, 'u1', 'aro-1.5');
  assertEquals([a.allowed, a.plan], [true, 'free']);
} });

Deno.test({ name: 'planned or disabled models are unavailable to everyone', ...opts, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: 'u1', p_plan: 'premium', p_days: null });
  const creative = await authorize(db, 'u1', 'aro-creative');
  assertEquals([creative.allowed, creative.reason], [false, 'model_unavailable']);
  await db.rpc('aro_admin_update_model', { p_admin: 'admin', p_id: 'aro-creative', p_patch: { status: 'preview' } });
  assert((await authorize(db, 'u1', 'aro-creative')).allowed);
  assertEquals((await authorize(db, 'u1', 'nope')).reason, 'unknown_model');
} });

Deno.test({ name: 'premium has no daily cap on ARO 1.5', ...opts, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: 'u1', p_plan: 'premium', p_days: null });
  let last;
  for (let i = 0; i < 60; i++) last = await authorize(db, 'u1', 'aro-1.5');
  assertEquals([last!.allowed, last!.limit, last!.remaining], [true, null, null]);
} });

Deno.test({ name: 'overview lists plan, credits and per-model access for the app', ...opts, fn: async () => {
  const db = await testDb();
  await authorize(db, 'u1', 'aro-1.5');
  const o = await overview(db, 'u1') as any;
  assertEquals(o.plan.id, 'free');
  assertEquals(o.credits, 0);
  const byId = Object.fromEntries(o.models.map((m: any) => [m.id, m]));
  assertEquals([byId['aro-1.5'].included, byId['aro-1.5'].daily_limit, byId['aro-1.5'].used_today], [true, 50, 1]);
  assertEquals(byId['aro-code'].included, false);
  assertEquals(o.plans.map((p: any) => p.id), ['free', 'pro', 'premium']);
  assertEquals(o.plans[1].models['aro-code'], 200);
  assert(o.credit_packs.length >= 1 && o.products.length >= 1);
} });

Deno.test({ name: 'admin changes are applied and audited', ...opts, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_upsert_plan', { p_admin: 'boss', p_plan: { id: 'pro', price_minor: 990000 } });
  await db.rpc('aro_admin_set_plan_model', { p_admin: 'boss', p_plan: 'free', p_model: 'aro-code', p_included: true, p_daily_limit: 5 });
  await db.rpc('aro_admin_set_plan_model', { p_admin: 'boss', p_plan: 'free', p_model: 'aro-vision', p_included: false, p_daily_limit: null });
  await db.rpc('aro_admin_update_model', { p_admin: 'boss', p_id: 'aro-vision', p_patch: { status: 'live', credit_cost: 4 } });
  const config = await db.rpc<any>('aro_admin_config', {});
  assertEquals(config.plans.find((p: any) => p.id === 'pro').price_minor, 990000);
  assert(config.plan_models.some((pm: any) => pm.plan_id === 'free' && pm.model_id === 'aro-code' && pm.daily_limit === 5));
  assert(!config.plan_models.some((pm: any) => pm.plan_id === 'free' && pm.model_id === 'aro-vision'));
  assertEquals(config.models.find((m: any) => m.id === 'aro-vision').credit_cost, 4);
  assertEquals((await authorize(db, 'u1', 'aro-code')).allowed, true);

  const audit = await db.sql<{ admin_uid: string; action: string }>('select admin_uid, action from aro_admin_audit order by id');
  assertEquals(audit.map((a) => a.action), ['upsert_plan', 'set_plan_model', 'set_plan_model', 'update_model']);
  assert(audit.every((a) => a.admin_uid === 'boss'));
  await assertRejects(() => db.rpc('aro_admin_update_model', { p_admin: 'boss', p_id: 'nope', p_patch: {} }));
} });

Deno.test({ name: 'usage report and evaluations for the dashboard', ...opts, fn: async () => {
  const db = await testDb();
  await authorize(db, 'u1', 'aro-1.5');
  await authorize(db, 'u2', 'aro-1.5');
  const usage = await db.rpc<any[]>('aro_admin_usage', { p_days: 7 });
  assertEquals(usage[0], { model_id: 'aro-1.5', requests: 2, users: 2, credits_spent: 0 });
  await db.sql(`insert into model_evaluations (model_id, candidate, promoted, candidate_score, current_score, metrics)
                values ('aro-code', 'run-1', true, 0.8, 0.6, '{"candidate": {"latency_mean_s": 1.2}}')`);
  const evals = await db.rpc<any[]>('aro_admin_evaluations', { p_model: 'aro-code', p_limit: 10 });
  assertEquals([evals.length, evals[0].candidate, evals[0].promoted], [1, 'run-1', true]);
} });

Deno.test({ name: "the app's keys (anon/authenticated) cannot read or call any of this", ...opts, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_add_credits', { p_admin: 'admin', p_user: 'u1', p_amount: 5, p_reason: 'x' });
  for (const role of ['anon', 'authenticated']) {
    await db.sql(`set role ${role}`);
    try {
      await assertRejects(() => db.sql('select * from aro_credit_balances'));
      await assertRejects(() => db.sql("update aro_credit_balances set balance = 999999 where user_id = 'u1'"));
      await assertRejects(() => db.sql("select aro_authorize('u1', 'aro-code', true)"));
      await assertRejects(() => db.sql("select aro_admin_grant_plan('me', 'u1', 'premium', null)"));
      await assertRejects(() => db.sql("insert into aro_user_plans (user_id, plan_id) values ('u1', 'premium')"));
    } finally {
      await db.sql('reset role');
    }
  }
} });

Deno.test('admins come from the ADMIN_UIDS secret', () => {
  const env = (n: string) => (n === 'ADMIN_UIDS' ? ' boss-uid , other ' : undefined);
  assert(isAdmin('boss-uid', env));
  assert(!isAdmin('someone', env));
  assert(!isAdmin('', () => undefined));
});
