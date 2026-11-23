// Cost guardrails: rate limits, GPU budget circuit breaker, usage/cost
// traces with alerts, answer-length caps, context fitting, the response
// cache, and the coding agent's per-run caps. Runs against real Postgres
// (PGlite) with the same migrations as production.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleRequest as chat } from '../ai-router/handler.ts';
import { handleRequest as agent } from '../aro-agent/handler.ts';
import { compactTranscript } from '../aro-agent/state.ts';
import { cacheable, estimateTokens, fitToContext, gate, GateError } from '../_shared/cost.ts';
import { readSseData } from '../_shared/http.ts';
import type { AgentMessage } from '../_shared/llm/tool_chat.ts';
import type { ChatMessage } from '../_shared/llm/types.ts';
import { testDb } from './pg.ts';

const pg = { sanitizeResources: false, sanitizeOps: false };
const verify = () => Promise.resolve({ uid: 'user-1' });
const env = (values: Record<string, string>) => (name: string) => values[name];
const ARO_ENV = env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1' });

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

function sse(lines: unknown[]): Response {
  const body = [...lines.map((l) => `data: ${JSON.stringify(l)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function frames(response: Response): Promise<any[]> {
  const out: any[] = [];
  for await (const payload of readSseData(response.body!)) if (payload !== '[DONE]') out.push(JSON.parse(payload));
  return out;
}

/** ARO server stub that answers "Hi there" and reports token usage. */
function aroServer() {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return sse([
      { choices: [{ delta: { content: 'Hi ' } }] },
      { choices: [{ delta: { content: 'there' } }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
    ]);
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

const ask = (content: string, extra: Record<string, unknown> = {}) =>
  post('ai-router', { provider: 'aro', model: 'aro-1.5', messages: [{ role: 'user', content }], ...extra });

// ------------------------------------------------------------ rate limits

Deno.test({ name: 'requests over the plan rate limit get a 429 with Retry-After', ...pg, fn: async () => {
  const db = await testDb();
  const server = aroServer();
  // Free: 6 per minute. Different questions so the cache doesn't answer.
  for (let i = 0; i < 6; i++) {
    const res = await chat(ask(`question ${i}`), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV });
    assertEquals(res.status, 200);
    await frames(res);
  }
  const blocked = await chat(ask('one more'), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV });
  assertEquals(blocked.status, 429);
  assert(Number(blocked.headers.get('retry-after')) >= 1);
  assertStringIncludes((await blocked.json()).error, '6 per minute');
  assertEquals(server.bodies.length, 6, 'the blocked request never reached the model');

  // Blocked before the plan check: it didn't use up a daily request either.
  const [usage] = await db.sql<{ requests: number }>("select requests from aro_usage_daily where user_id = 'user-1'");
  assertEquals(usage.requests, 6);

  // Pro allows more.
  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: 'user-1', p_plan: 'pro', p_days: 30 });
  assertEquals((await gate(db, 'user-1', true)).allowed, true);
} });

Deno.test({ name: 'the hourly limit applies too, and bring-your-own-key requests are rate limited', ...pg, fn: async () => {
  const db = await testDb();
  await db.sql("update aro_plans set requests_per_minute = 100, requests_per_hour = 2 where id = 'free'");
  await gate(db, 'user-1', false);
  await gate(db, 'user-1', false);
  try {
    await gate(db, 'user-1', false);
    throw new Error('expected a GateError');
  } catch (err) {
    assert(err instanceof GateError);
    assertEquals(err.status, 429);
    assertEquals(err.gate.window, 'hour');
  }
  // Other users are unaffected.
  assertEquals((await gate(db, 'user-2', false)).allowed, true);
} });

// --------------------------------------------------- budget + cost traces

Deno.test({ name: 'each call is traced with tokens and GPU cost; budget alerts fire once per threshold', ...pg, fn: async () => {
  const db = await testDb();
  await db.sql('update aro_cost_settings set daily_budget_usd = 1, hard_budget_usd = 2, gpu_usd_per_second = 0.5');
  const alerts: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url === 'https://hooks.example/alert') {
      alerts.push(JSON.parse(String(init.body)).text);
      return new Response('ok');
    }
    return await aroServer().fetchImpl(url, init);
  }) as typeof fetch;
  const log = (ms: number) =>
    db.rpc<any>('aro_log_usage', {
      p_event: {
        trace_id: crypto.randomUUID(), user_id: 'user-1', surface: 'chat', provider: 'aro', model: 'aro-1.5',
        served_by: 'aro', input_tokens: 10, output_tokens: 5, latency_ms: ms,
      },
    });

  const first = await log(1000); // 1 s × $0.50/s = 50% of the $1 budget
  assertEquals(first.cost_usd, 0.5);
  assertEquals(first.alerts.map((a: any) => Number(a.threshold)), [0.5]);
  const second = await log(700); // $0.85 → crosses 80%
  assertEquals(second.alerts.map((a: any) => Number(a.threshold)), [0.8]);
  assertEquals((await log(10)).alerts, []); // no repeat

  // Through the router: the trace id is in the meta frame and in the log.
  const out = await frames(await chat(ask('hello'), {
    verify, db, fetchImpl,
    env: env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', ARO_ALERT_WEBHOOK_URL: 'https://hooks.example/alert' }),
  }));
  const traceId = out[0].meta.traceId;
  const [event] = await db.sql<any>('select * from aro_usage_events where trace_id = $1', [traceId]);
  assertEquals([event.input_tokens, event.output_tokens, event.cached_tokens, event.status], [120, 30, 100, 'ok']);
  assertEquals(event.served_by, 'aro');
  assertEquals(alerts.length, 0, 'the quick reply cost too little to cross 100%');
} });

Deno.test({ name: 'circuit breaker: over budget, Free stops using ARO, paid plans continue until the hard cap, BYOK always works', ...pg, fn: async () => {
  const db = await testDb();
  const today = new Date().toISOString().slice(0, 10);
  await db.sql('insert into aro_spend_daily (day, cost_usd) values ($1, 6)', [today]); // soft 5, hard 10

  const blocked = await chat(ask('hi'), { verify, db, fetchImpl: aroServer().fetchImpl, env: ARO_ENV });
  assertEquals(blocked.status, 429);
  assertStringIncludes((await blocked.json()).error, 'at capacity for today');
  assertEquals((await gate(db, 'user-1', false)).allowed, true, 'own-key requests are not blocked by our budget');

  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: 'user-1', p_plan: 'pro', p_days: 30 });
  assertEquals((await gate(db, 'user-1', true)).allowed, true);

  await db.sql('update aro_spend_daily set cost_usd = 10 where day = $1', [today]);
  const hard = await gate(db, 'user-1', true).catch((e) => e);
  assert(hard instanceof GateError && hard.gate.reason === 'budget_exceeded');
} });

// ---------------------------------------------- answer length + context

Deno.test({ name: "ARO answers are capped by the plan's max_output_tokens and usage is requested", ...pg, fn: async () => {
  const db = await testDb();
  const server = aroServer();
  await frames(await chat(ask('hi', { cache: false }), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV }));
  assertEquals(server.bodies[0].max_tokens, 1024); // Free
  assertEquals(server.bodies[0].stream_options, { include_usage: true });

  await db.rpc('aro_admin_upsert_plan', { p_admin: 'admin', p_plan: { id: 'free', max_output_tokens: 300 } });
  await frames(await chat(ask('hi', { cache: false }), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV }));
  assertEquals(server.bodies[1].max_tokens, 300);
} });

Deno.test({ name: "long chats are fitted to ARO's context window, newest messages first", ...pg, fn: async () => {
  const db = await testDb();
  const server = aroServer();
  const long = 'x'.repeat(9_000); // ~3,000 tokens each
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `q${i} ${long}` }, { role: 'assistant', content: `a${i} ${long}` });
  }
  messages.push({ role: 'user', content: 'latest question' });
  const out = await frames(await chat(post('ai-router', { provider: 'aro', model: 'aro-1.5', messages }), {
    verify, db, fetchImpl: server.fetchImpl, env: env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', ARO_CONTEXT_TOKENS: '16384' }),
  }));
  const sent: ChatMessage[] = server.bodies[0].messages;
  assertEquals(sent[0].role, 'system');
  assertEquals(sent.at(-1)!.content, 'latest question');
  assertEquals(sent[1].role, 'user', 'never starts with an assistant turn');
  const tokens = sent.reduce((s, m) => s + estimateTokens(m.content), 0);
  assert(tokens <= 16384 - 1024 - 256, `sent ${tokens} tokens`);
  assert(out[0].meta.trimmed > 0);
} });

Deno.test('fitToContext shortens the middle of a single huge message', () => {
  const huge = 'start ' + 'y'.repeat(60_000) + ' end';
  const fit = fitToContext([{ role: 'system', content: 'sys' }, { role: 'user', content: huge }], 2_000);
  assert(fit.truncated);
  const text = fit.messages[1].content as string;
  assert(text.startsWith('start') && text.endsWith('end') && text.includes('middle of this message removed'));
  assert(estimateTokens(text) <= 2_000);
});

// ------------------------------------------------------------------ cache

Deno.test({ name: 'a repeated single-turn question is answered from the cache, without the GPU', ...pg, fn: async () => {
  const db = await testDb();
  const server = aroServer();
  const first = await frames(await chat(ask('What is the capital of Ghana?'), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV }));
  assertEquals(first.slice(1).map((f) => f.delta).join(''), 'Hi there');

  const again = await frames(await chat(ask('what is the capital of   ghana?'), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV }));
  assertEquals(server.bodies.length, 1, 'served from the cache');
  assertEquals(again[0].meta.cached, true);
  assertEquals(again[1], { delta: 'Hi there' });
  const [hit] = await db.sql<any>("select status, cost_usd from aro_usage_events where status = 'cache_hit'");
  assertEquals(Number(hit.cost_usd), 0);

  // Opt out, conversations and thinking requests are never cached.
  await frames(await chat(ask('What is the capital of Ghana?', { cache: false }), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV }));
  assertEquals(server.bodies.length, 2);
  assert(!cacheable([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], false));
  assert(!cacheable([{ role: 'user', content: 'a' }], true));

  // The admin can turn it off.
  await db.rpc('aro_admin_update_cost_settings', { p_admin: 'admin', p_patch: { cache_ttl_seconds: 0 } });
  await frames(await chat(ask('What is the capital of Ghana?'), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV }));
  assertEquals(server.bodies.length, 3);
} });

// ------------------------------------------------------------------ agent

function agentFetch(onModel: (body: any) => any) {
  return (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.hostname !== 'api.github.com') return Response.json(onModel(JSON.parse(String(init.body))));
    if (url.pathname === '/repos/acme/app') return Response.json({ default_branch: 'main', permissions: { push: true } });
    if (url.pathname.startsWith('/repos/acme/app/git/ref/heads/')) return Response.json({ object: { sha: 'c0' } });
    if (url.pathname.startsWith('/repos/acme/app/git/trees/')) {
      return Response.json({ tree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'x' }], truncated: false });
    }
    return Response.json({ message: 'unhandled' }, { status: 500 });
  }) as typeof fetch;
}

const agentBody = {
  provider: 'openai', model: 'gpt-test', apiKey: 'sk-test', githubToken: 'github_pat_test',
  repo: { owner: 'acme', name: 'app' }, message: 'look around',
};

function toolTurn(name: string, args: unknown, usage?: unknown) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    ...(usage ? { usage } : {}),
  };
}

Deno.test({ name: "agent runs stop at the plan's token allowance and every step is traced", ...pg, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_upsert_plan', { p_admin: 'admin', p_plan: { id: 'free', agent_max_tokens: 2000 } });
  let turn = 0;
  const out = await frames(await agent(post('aro-agent', agentBody), {
    verify, db,
    fetchImpl: agentFetch(() => toolTurn('list_files', { path: `dir${turn++}` }, { prompt_tokens: 900, completion_tokens: 200 })),
  }));
  assertEquals(turn, 2, '2 × 1,100 tokens: stops before a third call');
  assertEquals(out.at(-1), { type: 'done', status: 'paused' });
  assertStringIncludes(out.find((e) => e.type === 'status' && e.text.includes('token allowance')).text, 'Continue');
  const usage = out.find((e) => e.type === 'usage');
  assertEquals([usage.steps, usage.tokens], [2, 2200]);
  const rows = await db.sql<any>("select surface, input_tokens, trace_id from aro_usage_events where surface = 'agent'");
  assertEquals(rows.length, 2);
  assertEquals(rows[0].trace_id, usage.traceId);
} });

Deno.test({ name: 'agent loop breaker: the same call over and over is stopped', ...pg, fn: async () => {
  const db = await testDb();
  let turn = 0;
  const out = await frames(await agent(post('aro-agent', agentBody), {
    verify, db, fetchImpl: agentFetch(() => (turn++, toolTurn('list_files', { path: 'same' }))),
  }));
  assertEquals(turn, 3);
  assertEquals(out.filter((e) => e.type === 'tool').length, 2, 'the third identical call is not run');
  assertEquals(out.at(-1), { type: 'done', status: 'paused' });
  assert(out.some((e) => e.type === 'status' && e.text.includes('repeating the same step')));
} });

Deno.test({ name: "agent max steps comes from the plan", ...pg, fn: async () => {
  const db = await testDb();
  await db.rpc('aro_admin_upsert_plan', { p_admin: 'admin', p_plan: { id: 'free', agent_max_steps: 2 } });
  let turn = 0;
  const out = await frames(await agent(post('aro-agent', agentBody), {
    verify, db, fetchImpl: agentFetch(() => toolTurn('list_files', { path: `d${turn++}` })),
  }));
  assertEquals(turn, 2);
  assert(out.some((e) => e.type === 'status' && e.text.includes('step limit')));
} });

Deno.test('a small context window shortens even recent large tool results', () => {
  const big = 'z'.repeat(50_000);
  const transcript: AgentMessage[] = [
    { role: 'user', text: 'task' },
    { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'read_file', args: {} }] },
    { role: 'tool', results: [{ id: '1', name: 'read_file', content: big }] },
    { role: 'assistant', text: '', toolCalls: [{ id: '2', name: 'read_file', args: {} }] },
    { role: 'tool', results: [{ id: '2', name: 'read_file', content: big }] },
  ];
  const out = compactTranscript(transcript, 40_000);
  assert(JSON.stringify(out).length <= 40_000);
  assertEquals(out.length, transcript.length, 'nothing dropped: all within the last few messages');
  assertEquals(compactTranscript(transcript).length, transcript.length);
  assertEquals(JSON.stringify(compactTranscript(transcript)), JSON.stringify(transcript), 'large windows keep recent output in full');
});

// ------------------------------------------------------------------ admin

Deno.test({ name: 'admin cost report and settings', ...pg, fn: async () => {
  const db = await testDb();
  await frames(await chat(ask('hello'), { verify, db, fetchImpl: aroServer().fetchImpl, env: ARO_ENV }));
  const report = await db.rpc<any>('aro_admin_costs', { p_days: 7 });
  assertEquals(report.models[0].model, 'aro-1.5');
  assertEquals(report.models[0].calls, 1);
  assertEquals(report.top_users[0].user_id, 'user-1');
  assertEquals(Number(report.settings.daily_budget_usd), 5);

  const updated = await db.rpc<any>('aro_admin_update_cost_settings', {
    p_admin: 'admin', p_patch: { daily_budget_usd: 20, hard_budget_usd: 30, alert_thresholds: [0.9] },
  });
  assertEquals([Number(updated.daily_budget_usd), updated.alert_thresholds.map(Number)], [20, [0.9]]);
  const [audit] = await db.sql<any>("select action from aro_admin_audit where action = 'update_cost_settings'");
  assert(audit);

  // Still locked down for the app's own keys.
  for (const role of ['anon', 'authenticated']) {
    const denied = await db.pg.query(`set role ${role}; select public.aro_gate('x', true)`).catch((e) => e);
    assert(denied instanceof Error, `${role} must not call aro_gate`);
    await db.pg.query('reset role');
  }
} });

Deno.test({ name: 'admins skip rate limits and the budget breaker', ...pg, fn: async () => {
  const db = await testDb();
  const today = new Date().toISOString().slice(0, 10);
  await db.sql('insert into aro_spend_daily (day, cost_usd) values ($1, 100)', [today]); // over the hard budget
  const server = aroServer();
  const adminEnv = env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', ADMIN_UIDS: 'user-1' });
  for (let i = 0; i < 10; i++) { // more than Free's 6 per minute
    const res = await chat(ask(`admin question ${i}`), { verify, db, fetchImpl: server.fetchImpl, env: adminEnv });
    assertEquals(res.status, 200);
    await frames(res);
  }
  assertEquals(server.bodies.length, 10);
  assertEquals(server.bodies[0].max_tokens, 8192);
  // Everyone else is still stopped by the breaker.
  const other = await chat(ask('hi'), { verify, db, fetchImpl: server.fetchImpl, env: ARO_ENV });
  assertEquals(other.status, 429);
} });
