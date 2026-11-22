import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleRequest as adminRequest } from '../aro-admin/handler.ts';
import { handleRequest as routerRequest } from '../ai-router/handler.ts';
import { routeAroModel } from '../_shared/aro.ts';
import { readSseData } from '../_shared/http.ts';
import { testDb } from './pg.ts';

const opts = { sanitizeResources: false, sanitizeOps: false };
const USER = 'firebase-user-1';
const verify = () => Promise.resolve({ uid: USER });
const env = (values: Record<string, string>) => (name: string) => values[name];
const ARO_ENV = env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', ADMIN_UIDS: 'admin-uid-1' });

function post(body: unknown): Request {
  return new Request('http://localhost/fn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

async function frames(response: Response): Promise<any[]> {
  const out: any[] = [];
  for await (const payload of readSseData(response.body!)) out.push(payload === '[DONE]' ? '[DONE]' : JSON.parse(payload));
  return out;
}

/** Fake vLLM server: records which model and system prompt were asked for. */
function aroServer(served = ['aro-1.5', 'aro-code', 'aro-research', 'aro-translate']) {
  const calls: { model: string; system: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ model: body.model, system: body.messages[0].content });
    if (!served.includes(body.model)) {
      return new Response(JSON.stringify({ error: { message: `The model \`${body.model}\` does not exist.` } }), { status: 404 });
    }
    const chunk = JSON.stringify({ choices: [{ delta: { content: `answer from ${body.model}` } }] });
    return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const chat = (text: string, model = 'auto') => post({ provider: 'aro', model, messages: [{ role: 'user', content: text }] });

// --------------------------------------------------------- auto routing

Deno.test('auto routing picks the specialist by topic', () => {
  const route = (text: string, images = false) => routeAroModel([{ role: 'user', content: text }], images).model;
  assertEquals(route("Translate 'good morning' into Hausa"), 'aro-translate');
  assertEquals(route('How do you say thank you in Yoruba?'), 'aro-translate');
  assertEquals(route('Why does my Python function throw a KeyError?'), 'aro-code');
  assertEquals(route('```js\nconsole.log(x)\n```'), 'aro-code');
  assertEquals(route('Prove that the square root of 2 is irrational'), 'aro-research');
  assertEquals(route('Solve 3x + 7 = 22'), 'aro-research');
  assertEquals(route('Write a short poem about Lagos'), 'aro-1.5');
  assertEquals(route('What is this?', true), 'aro-vision');
});

Deno.test({ name: 'Pro user: Auto sends a coding question to ARO Code with its own prompt', ...opts, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: USER, p_plan: 'pro', p_days: 30 });
  const server = aroServer();
  const out = await frames(await routerRequest(chat('Fix this bug in my JavaScript code'), { verify, db, env: ARO_ENV, fetchImpl: server.fetchImpl }));
  assertEquals(server.calls[0].model, 'aro-code');
  assertStringIncludes(server.calls[0].system, 'ARO Code');
  assertEquals([out[0].meta.aroModel, out[0].meta.routed, out[0].meta.notice], ['aro-code', true, undefined]);
  assertEquals(out[1], { delta: 'answer from aro-code' });
} });

Deno.test({ name: 'Free user: Auto never blocks — ARO 1.5 answers and the app is told why', ...opts, fn: async () => {
  const db = await testDb();
  const server = aroServer();
  const out = await frames(await routerRequest(chat('Fix this bug in my JavaScript code'), { verify, db, env: ARO_ENV, fetchImpl: server.fetchImpl }));
  assertEquals(server.calls.map((c) => c.model), ['aro-1.5']);
  assertEquals(out[0].meta.aroModel, 'aro-1.5');
  assertStringIncludes(out[0].meta.notice, "ARO Code isn't included in Free");
  assertStringIncludes(out[0].meta.notice, 'ARO 1.5 answered instead');
} });

Deno.test({ name: 'a specialist without a published adapter answers through ARO 1.5 on the same server', ...opts, fn: async () => {
  const db = await testDb();
  const server = aroServer(['aro-1.5']); // only ARO 1.5 trained so far
  const out = await frames(await routerRequest(chat('Translate hello into Swahili', 'aro-translate'), { verify, db, env: ARO_ENV, fetchImpl: server.fetchImpl }));
  assertEquals(server.calls.map((c) => c.model), ['aro-translate', 'aro-1.5']);
  assertStringIncludes(server.calls[1].system, 'ARO Translate'); // keeps the specialist's instructions
  assertEquals([out[0].meta.aroModel, out[0].meta.model], ['aro-translate', 'aro-1.5']); // training credit goes to aro-1.5
} });

Deno.test({ name: 'explicitly chosen models are enforced: 402 upgrade, 429 daily limit', ...opts, fn: async () => {
  const db = await testDb();
  const server = aroServer();
  const upgrade = await routerRequest(chat('hello', 'aro-code'), { verify, db, env: ARO_ENV, fetchImpl: server.fetchImpl });
  assertEquals(upgrade.status, 402);
  assertStringIncludes((await upgrade.json()).error, "It's included in Pro and Premium");

  await db.sql("update aro_plan_models set daily_limit = 1 where plan_id = 'free' and model_id = 'aro-1.5'");
  assertEquals((await routerRequest(chat('hi', 'aro-1.5'), { verify, db, env: ARO_ENV, fetchImpl: server.fetchImpl })).status, 200);
  const limited = await routerRequest(chat('hi again', 'aro-1.5'), { verify, db, env: ARO_ENV, fetchImpl: server.fetchImpl });
  assertEquals(limited.status, 429);
  assertStringIncludes((await limited.json()).error, 'used all 1 ARO 1.5 requests');
  assertEquals(server.calls.length, 1, 'denied requests never reach the model');
} });

Deno.test({ name: 'failed answers are refunded', ...opts, fn: async () => {
  const db = await testDb();
  const down = (async () => { throw new TypeError('connection refused'); }) as typeof fetch;
  const out = await frames(await routerRequest(chat('hi', 'aro-1.5'), { verify, db, env: ARO_ENV, fetchImpl: down }));
  assertStringIncludes(out[0].error, 'unreachable');
  const usage = await db.sql<{ requests: number }>('select requests from aro_usage_daily where user_id = $1', [USER]);
  assertEquals(usage[0].requests, 0);
} });

Deno.test({ name: 'images: Auto picks ARO Vision; text-only ARO models refuse them', ...opts, fn: async () => {
  const db = await testDb();
  const image = { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mimeType: 'image/png', data: 'AAA' }] };
  const planned = await routerRequest(post({ provider: 'aro', model: 'auto', messages: [image] }), { verify, db, env: ARO_ENV });
  assertEquals(planned.status, 503);
  assertStringIncludes((await planned.json()).error, "ARO Vision isn't available yet");

  const wrong = await routerRequest(post({ provider: 'aro', model: 'aro-1.5', messages: [image] }), { verify, db, env: ARO_ENV });
  assertEquals(wrong.status, 400);

  await db.rpc('aro_admin_update_model', { p_admin: 'admin', p_id: 'aro-vision', p_patch: { status: 'live' } });
  let visionUrl = '';
  const vision = (async (url: string) => {
    visionUrl = url;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A cat' } }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  const out = await frames(await routerRequest(post({ provider: 'aro', model: 'auto', messages: [image] }), {
    verify, db, fetchImpl: vision, env: env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', ARO_VISION_BASE_URL: 'https://vision.example/v1' }),
  }));
  assertEquals(visionUrl, 'https://vision.example/v1/chat/completions');
  assertEquals(out[0].meta.aroModel, 'aro-vision');
} });

Deno.test({ name: 'overview action: plan, usage and admin flag for the app', ...opts, fn: async () => {
  const db = await testDb();
  const res = await routerRequest(post({ action: 'overview' }), { verify, db, env: ARO_ENV });
  const body = await res.json();
  assertEquals([body.plan.id, body.is_admin, body.models.length], ['free', false, 7]);
  const admin = await routerRequest(post({ action: 'overview' }), { verify: () => Promise.resolve({ uid: 'admin-uid-1' }), db, env: ARO_ENV });
  assertEquals((await admin.json()).is_admin, true);
} });

// ------------------------------------------------------------------ admin

const admin = () => Promise.resolve({ uid: 'admin-uid-1' });

Deno.test({ name: 'admin API: admins only, validated, and changes take effect', ...opts, fn: async () => {
  const db = await testDb();
  assertEquals((await adminRequest(post({ action: 'config' }), { verify, db, env: ARO_ENV })).status, 403);

  const config = await (await adminRequest(post({ action: 'config' }), { verify: admin, db, env: ARO_ENV })).json();
  assertEquals(config.models.length, 7);

  const bad = await adminRequest(post({ action: 'updateModel', id: 'aro-code', patch: { status: 'awesome' } }), { verify: admin, db, env: ARO_ENV });
  assertEquals(bad.status, 400);
  const badUser = await adminRequest(post({ action: 'grantPlan', userId: "x'; drop table--", planId: 'pro' }), { verify: admin, db, env: ARO_ENV });
  assertEquals(badUser.status, 400);
  const unknown = await adminRequest(post({ action: 'grantPlan', userId: USER, planId: 'gold' }), { verify: admin, db, env: ARO_ENV });
  assertEquals(unknown.status, 404);

  const granted = await (await adminRequest(post({ action: 'grantPlan', userId: USER, planId: 'pro', days: 30 }), { verify: admin, db, env: ARO_ENV })).json();
  assertEquals(granted.plan.id, 'pro');
  const credits = await (await adminRequest(post({ action: 'addCredits', userId: USER, amount: 50 }), { verify: admin, db, env: ARO_ENV })).json();
  assertEquals(credits.balance, 50);
  const price = await adminRequest(post({ action: 'upsertPlan', plan: { id: 'pro', price_minor: 1_000_000 } }), { verify: admin, db, env: ARO_ENV });
  assertEquals((await price.json()).price_minor, 1_000_000);
  await adminRequest(post({ action: 'setPlanModel', planId: 'free', modelId: 'aro-research', included: true, dailyLimit: 3 }), { verify: admin, db, env: ARO_ENV });
  const view = await (await adminRequest(post({ action: 'userOverview', userId: 'someone-else-1' }), { verify: admin, db, env: ARO_ENV })).json();
  assertEquals(view.models.find((m: any) => m.id === 'aro-research').daily_limit, 3);

  const audit = await db.sql<{ admin_uid: string }>('select admin_uid from aro_admin_audit');
  assert(audit.length >= 4 && audit.every((a) => a.admin_uid === 'admin-uid-1'));
} });
