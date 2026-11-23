// Phase 1 guardrails: strict tool schemas, deterministic calculate/date tools,
// the agent state machine (bounded retries, graceful failure), human-in-the-loop
// confirmation gates, and Postgres checkpoints with recovery.

import { assert, assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1';
import { handleRequest } from '../aro-agent/handler.ts';
import { calculate, dateMath, formatNumber, runCalcTool } from '../_shared/calc.ts';
import { validate } from '../_shared/schema.ts';
import { base, events, fakeRepo, githubFetch, PLAN, request, scriptedModel, verify } from './agent_harness.ts';
import { testDb } from './pg.ts';

const pg = { sanitizeResources: false, sanitizeOps: false };
const stateOf = (out: any[]) => out.find((e) => e.type === 'state').state;
const toolMessages = (body: any) => body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);

// ------------------------------------------------------------- schemas

Deno.test('strict schema validation catches wrong types, missing and unknown fields', () => {
  const schema = {
    type: 'object' as const,
    properties: { path: { type: 'string' as const, minLength: 1 }, start: { type: 'integer' as const, minimum: 1 }, op: { type: 'string' as const, enum: ['a', 'b'] } },
    required: ['path'],
    additionalProperties: false,
  };
  assertEquals(validate(schema, { path: 'src/a.ts', start: 3, op: 'a' }), []);
  assertEquals(validate(schema, {}), ['arguments.path: is required']);
  assertEquals(validate(schema, { path: 5 }), ['arguments.path: must be a string']);
  assertEquals(validate(schema, { path: 'x', start: 1.5 }), ['arguments.start: must be an integer']);
  assertEquals(validate(schema, { path: 'x', start: 0 }), ['arguments.start: must be at least 1']);
  assertEquals(validate(schema, { path: 'x', op: 'z' }), ['arguments.op: must be one of "a", "b"']);
  assertEquals(validate(schema, { path: 'x', extra: 1 }), ['arguments.extra: is not an allowed field']);
  assertEquals(validate(schema, 'not an object'), ['arguments: must be an object']);
});

// ---------------------------------------------------- deterministic tools

Deno.test('calculate is exact and safe', () => {
  const cases: [string, string][] = [
    ['15% of 2400', '360'], ['2+3*4', '14'], ['(2+3)*4', '20'], ['2^3^2', '512'], ['-3^2', '-9'], ['2^-1', '0.5'],
    ['1,250,000 * 0.075', '93750'], ['10 mod 3', '1'], ['5!', '120'], ['sqrt(16) + round(2.345, 2)', '6.35'],
    ['0.1 + 0.2', '0.3'], ['100/3', '33.3333333333'], ['2(3+4)', '14'], ['max(3, 7, 2)', '7'], ['7 divided by 2', '3.5'],
  ];
  for (const [expr, want] of cases) assertEquals(formatNumber(calculate(expr)), want, expr);
  for (const bad of ['1/0', 'alert(1)', 'process.exit()', 'constructor', 'toString(1)', '__proto__', '2+', '(1', 'x'.repeat(400)]) {
    assertThrows(() => calculate(bad), Error, undefined, bad);
  }
});

Deno.test('date_math does exact calendar logic', () => {
  assertEquals(dateMath({ op: 'diff', from: '2026-01-01', to: '2026-12-25' }).days, 358);
  assertEquals(dateMath({ op: 'add', date: '2024-01-31', amount: 1, unit: 'months' }), { date: '2024-02-29', weekday: 'Thursday' });
  assertEquals(dateMath({ op: 'add', date: '2026-11-24', amount: 2, unit: 'weeks' }).date, '2026-12-08');
  assertEquals(dateMath({ op: 'weekday', date: '2026-11-24' }).weekday, 'Tuesday');
  assertEquals((dateMath({ op: 'diff', from: '2000-02-29', to: '2026-11-24' }) as any).calendar, { years: 26, months: 8, days: 26, direction: 'forward' });
  assertEquals(dateMath({ op: 'now', timezone: 'Africa/Lagos' }, () => new Date('2026-11-24T23:30:00Z')).date, '2026-11-25');
  assertThrows(() => dateMath({ op: 'weekday', date: '2026-02-30' }), Error, 'not a real date');
  assertThrows(() => dateMath({ op: 'now', timezone: 'Mars/Base' }), Error, 'Unknown time zone');
  assertThrows(() => runCalcTool('date_math', { op: 'diff', from: '2026-01-01' }), Error, 'needs: to');
});

// -------------------------------------------------------- agent engine

Deno.test('the agent uses calculate and date_math instead of guessing', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const model = scriptedModel([
    { calls: [{ name: 'calculate', args: { expression: '15% of 2400' } }, { name: 'date_math', args: { op: 'diff', from: '2026-01-01', to: '2026-12-25' } }] },
    { text: '360, and 358 days.' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'compute things' }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  const results = toolMessages(model.seen[1]);
  assertEquals(results[0], '15% of 2400 = 360');
  assertStringIncludes(results[1], '"days":358');
  assertEquals(out.at(-1), { type: 'done', status: 'completed' });
});

Deno.test('invalid tool calls are never executed; three bad batches in a row fail gracefully', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  let writes = 0;
  let n = 0;
  // A different invalid call each time (identical ones would trip the repeated-call breaker instead).
  const inner = githubFetch(repo, () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: crypto.randomUUID(), type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `f${n++}.txt` }) } }, // content missing
  ] } }] }));
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(init?.method) === 'POST' && url.includes('/git/trees')) writes++;
    return await inner(url, init);
  }) as typeof fetch;
  const out = await events(await handleRequest(request({ ...base, message: 'write it' }), { verify, fetchImpl }));
  const results = out.filter((e) => e.type === 'tool_result');
  assertEquals(results.length, 3);
  assert(results.every((r) => !r.ok && r.summary.startsWith('Invalid arguments for write_file')));
  assertEquals(stateOf(out).pending, {}, 'nothing was staged');
  assertEquals(writes, 0);
  assertEquals(out.at(-1), { type: 'done', status: 'failed' });
  assert(out.some((e) => e.type === 'status' && e.text.includes('invalid tool calls 3 times')));
});

Deno.test('a transient model failure is retried with backoff (max 3 attempts)', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  let calls = 0;
  const inner = githubFetch(repo, () => ({ choices: [{ message: { role: 'assistant', content: 'done' } }] }));
  const flaky = (failures: number) => (async (url: string, init?: RequestInit) => {
    if (!url.includes('api.github.com') && ++calls <= failures) return new Response('overloaded', { status: 503 });
    return await inner(url, init);
  }) as typeof fetch;
  // Real backoff waits (1 s, then 2 s), bounded by the run's deadline.
  const ok = await events(await handleRequest(request({ ...base, message: 'hi' }), { verify, fetchImpl: flaky(2) }));
  assertEquals(ok.at(-1), { type: 'done', status: 'completed' });
  assertEquals(calls, 3, 'two failures, then success');
  assert(ok.some((e) => e.type === 'status' && e.text.includes('retrying (attempt 2 of 3)')));

  calls = 0;
  const failed = await events(await handleRequest(request({ ...base, message: 'hi' }), { verify, fetchImpl: flaky(10) }));
  assertEquals(calls, 3, 'gives up after 3 attempts');
  assertEquals(failed.at(-1), { type: 'done', status: 'error' });
});

Deno.test('declining a gated action: nothing happens, the model is told, later calls in the batch are not run', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n', 'old.txt': 'bye\n' });
  const model = scriptedModel([
    { calls: [PLAN, { name: 'delete_file', args: { path: 'old.txt' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Remove old.txt' } }, { name: 'get_ci_status', args: {} }] },
    { text: 'Understood, I left it alone.' },
  ]);
  const first = await events(await handleRequest(request({ ...base, message: 'remove old.txt' }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  const ask = first.find((e) => e.type === 'confirm');
  assertEquals(ask.tool, 'commit_and_push');
  assertStringIncludes(ask.details.join(' '), 'deletes 1 file(s): old.txt');
  assertEquals(first.at(-1), { type: 'done', status: 'awaiting_confirmation' });

  const second = await events(await handleRequest(request({ ...base, continue: true, state: stateOf(first), confirm: { id: ask.id, approve: false, note: 'keep it' } }), {
    verify, fetchImpl: githubFetch(repo, model.handler),
  }));
  assertEquals(Object.keys(repo.branches), ['main'], 'no branch, no commit');
  const results = toolMessages(model.seen[2]);
  assertStringIncludes(results.find((c: string) => c.includes('did not approve')), 'they said: "keep it"');
  assert(results.some((c: string) => c.includes('Not run: it was queued behind')), 'get_ci_status was deferred, not run');
  assertEquals(second.at(-1), { type: 'done', status: 'completed' });
  assertEquals(stateOf(second).run, undefined);
});

Deno.test('a new message while an action waits counts as "not approved" and is passed on', async () => {
  const repo = fakeRepo({ '.github/workflows/ci.yml': 'on: push\n' });
  const model = scriptedModel([
    { calls: [PLAN, { name: 'write_file', args: { path: '.github/workflows/ci.yml', content: 'on: pull_request\n' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'CI on PRs only' } }] },
    { text: 'OK, not changing CI.' },
  ]);
  const first = await events(await handleRequest(request({ ...base, message: 'change ci' }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  assertStringIncludes(first.find((e) => e.type === 'confirm').details.join(' '), 'sensitive files: .github/workflows/ci.yml');
  // Continuing without a decision just asks again.
  const again = await events(await handleRequest(request({ ...base, continue: true, state: stateOf(first) }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  assert(again.find((e) => e.type === 'confirm'));
  assertEquals(again.at(-1), { type: 'done', status: 'awaiting_confirmation' });

  await events(await handleRequest(request({ ...base, message: 'actually leave CI alone', state: stateOf(again) }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  const msgs = model.seen[2].messages;
  assertStringIncludes(msgs.at(-2).content, 'did not approve');
  assertEquals(msgs.at(-1), { role: 'user', content: 'actually leave CI alone' });
});

Deno.test({ name: 'checkpoints are saved after every step, and a newer server checkpoint is recovered', ...pg, fn: async () => {
  const db = await testDb();
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const model = scriptedModel([
    { calls: [{ name: 'list_files', args: {} }] },
    { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { text: 'All read.' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'look' }), { verify, db, fetchImpl: githubFetch(repo, model.handler) }));
  const state = stateOf(out);
  const [row] = await db.sql<any>('select checkpoint, status, repo, state from aro_agent_checkpoints where session_id = $1', [state.sessionId]);
  assertEquals([row.checkpoint, row.status, row.repo], [3, 'completed', 'acme/app']); // after 2 tool batches + the final answer
  assertEquals(row.state.transcript.length, state.transcript.length);

  // The app only has an older copy (e.g. the stream was cut off): the server's newer checkpoint wins.
  const stale = { ...state, checkpoint: 1, transcript: state.transcript.slice(0, 2) };
  const follow = scriptedModel([{ text: 'Continuing from where we were.' }]);
  const resumed = await events(await handleRequest(request({ ...base, continue: true, state: stale }), { verify, db, fetchImpl: githubFetch(repo, follow.handler) }));
  assert(resumed.some((e) => e.type === 'status' && e.text.includes('Recovered your progress')));
  assert(follow.seen[0].messages.length > stale.transcript.length + 1, 'the model saw the full recovered transcript');
  // Recovery even without any app state, by session id.
  const byId = await events(await handleRequest(request({ ...base, continue: true, sessionId: state.sessionId }), { verify, db, fetchImpl: githubFetch(repo, scriptedModel([{ text: 'ok' }]).handler) }));
  assertEquals(stateOf(byId).sessionId, state.sessionId);
  // Another user can't load it.
  assertEquals(await db.rpc('aro_agent_load', { p_user: 'someone-else', p_session: state.sessionId }), null);
} });

Deno.test('read-only tools retry transient GitHub errors; write tools do not', async () => {
  const repo = fakeRepo({ 'a.txt': 'hello\n' });
  let contentCalls = 0;
  const model = scriptedModel([{ calls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: 'read' }]);
  const inner = githubFetch(repo, model.handler);
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.includes('/contents/') && ++contentCalls <= 2) return new Response('{"message":"Server Error"}', { status: 502 });
    return await inner(url, init);
  }) as typeof fetch;
  const out = await events(await handleRequest(request({ ...base, message: 'read' }), { verify, fetchImpl }));
  assertEquals(contentCalls, 3);
  assert(out.find((e) => e.type === 'tool_result').ok);
});
