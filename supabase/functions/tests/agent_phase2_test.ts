// Phase 2: plan before acting, review before commit, episodic log, and the
// second check for long code answers in chat.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleRequest, MAX_REVIEW_ROUNDS } from '../aro-agent/handler.ts';
import { codeLines, handleRequest as chat } from '../ai-router/handler.ts';
import { unifiedDiff } from '../_shared/diff.ts';
import { base, events, fakeRepo, githubFetch, PLAN, request, type ScriptedReview, scriptedModel, verify } from './agent_harness.ts';
import { testDb } from './pg.ts';

const pg = { sanitizeResources: false, sanitizeOps: false };
const stateOf = (out: any[]) => out.find((e) => e.type === 'state').state;
const toolResults = (out: any[], name: string) => out.filter((e) => e.type === 'tool_result' && e.name === name);
const blocker = (problem: string, file?: string): ScriptedReview => ({ verdict: 'revise', issues: [{ severity: 'blocker', problem, ...(file ? { file } : {}) }] });

Deno.test('unified diffs show only what changed', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
  const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
  const diff = unifiedDiff('x.txt', before, after);
  assertStringIncludes(diff, '--- a/x.txt\n+++ b/x.txt');
  assertStringIncludes(diff, '-e\n+E');
  assertStringIncludes(diff, '+k');
  assert(!diff.includes(' a\n'), 'lines far from a change are left out');
  assertStringIncludes(unifiedDiff('new.txt', null, 'hi\n'), '--- /dev/null');
  assertStringIncludes(unifiedDiff('old.txt', 'bye', null), '+++ /dev/null');
  assertEquals(unifiedDiff('same.txt', 'x', 'x'), '');
  const long = unifiedDiff('big.txt', '', Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n'), 3, 50);
  assertStringIncludes(long, 'diff shortened');
});

Deno.test('changes are refused until there is a plan; the plan is shown and kept in the prompt', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const model = scriptedModel([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'y\n' } }] },
    { calls: [PLAN, { name: 'write_file', args: { path: 'a.txt', content: 'y\n' } }] },
    { text: 'Staged.' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'change a' }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  const writes = toolResults(out, 'write_file');
  assertEquals(writes[0].ok, false);
  assertStringIncludes(writes[0].summary, 'write your plan first with set_plan');
  assertEquals(writes[1].ok, true);
  const plan = out.find((e) => e.type === 'plan').plan;
  assertEquals(plan.goal, 'Do the task');
  assertEquals(stateOf(out).plan.steps.length, 2);
  assertEquals(stateOf(out).pending, { 'a.txt': 'y\n' });
  assertStringIncludes(model.seen[2].messages[0].content, 'Your current plan:\nGoal: Do the task\n[~] 1. Make the change');
});

Deno.test('a model that never plans gets a minimal plan after two refusals, so the run never stalls', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const write = { name: 'write_file', args: { path: 'a.txt', content: 'y\n' } };
  const model = scriptedModel([{ calls: [write] }, { calls: [{ ...write, args: { path: 'a.txt', content: 'z\n' } }] }, { calls: [write] }, { text: 'ok' }]);
  const out = await events(await handleRequest(request({ ...base, message: 'Make a.txt say y' }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  assertEquals(toolResults(out, 'write_file').map((r) => r.ok), [false, false, true]);
  assertEquals(stateOf(out).plan.goal, 'Make a.txt say y');
});

Deno.test('a new message makes the plan stale: the next change needs an updated plan', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const first = scriptedModel([{ calls: [PLAN, { name: 'write_file', args: { path: 'a.txt', content: 'y\n' } }] }, { text: 'ok' }]);
  const out1 = await events(await handleRequest(request({ ...base, message: 'one' }), { verify, fetchImpl: githubFetch(repo, first.handler) }));
  const second = scriptedModel([
    { calls: [{ name: 'write_file', args: { path: 'b.txt', content: 'b\n' } }] },
    { calls: [{ ...PLAN, args: { goal: 'Add b', steps: [{ title: 'Write b.txt', status: 'done' }] } }, { name: 'write_file', args: { path: 'b.txt', content: 'b\n' } }] },
    { text: 'ok' },
  ]);
  const out2 = await events(await handleRequest(request({ ...base, message: 'also add b', state: stateOf(out1) }), { verify, fetchImpl: githubFetch(repo, second.handler) }));
  assertStringIncludes(second.seen[0].messages[0].content, 'Your previous plan (the user has sent a new message since');
  assertEquals(toolResults(out2, 'write_file').map((r) => r.ok), [false, true]);
  assertStringIncludes(toolResults(out2, 'write_file')[0].summary, 'update your plan');
  assertEquals(stateOf(out2).planStale, false);
  assertEquals(stateOf(out2).plan.goal, 'Add b');
});

Deno.test('the reviewer sees the real diff and can hold a commit back until it is fixed', async () => {
  const repo = fakeRepo({ 'src/math.js': 'export const add = (a, b) => a - b;\n' });
  const model = scriptedModel([
    { calls: [PLAN, { name: 'write_file', args: { path: 'src/math.js', content: 'export const add = (a, b) => a + c;\n' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Fix add' } }] },
    { calls: [{ name: 'write_file', args: { path: 'src/math.js', content: 'export const add = (a, b) => a + b;\n' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Fix add' } }] },
    { text: 'Fixed.' },
  ], [blocker('`c` is not defined; it should be `b`.', 'src/math.js')]);
  const out = await events(await handleRequest(request({ ...base, message: 'add() is wrong' }), { verify, fetchImpl: githubFetch(repo, model.handler) }));

  const reviewed = model.reviewsSeen[0].messages.at(-1).content;
  assertStringIncludes(reviewed, "The user's request:\nadd() is wrong");
  assertStringIncludes(reviewed, '-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + c;');
  assertStringIncludes(reviewed, 'Goal: Do the task');

  const reviews = out.filter((e) => e.type === 'review');
  assertEquals(reviews.map((r) => r.verdict), ['revise', 'approve']);
  const commits = toolResults(out, 'commit_and_push');
  assertEquals(commits[0].ok, false);
  assertStringIncludes(commits[0].summary, 'Not committed: a code review');
  assertStringIncludes(model.seen[2].messages.at(-1).content, '[blocker] src/math.js: `c` is not defined');
  assertEquals(commits[1].ok, true);
  assertEquals(out.filter((e) => e.type === 'commit').length, 1);
  const pushed = repo.commits[repo.branches[stateOf(out).workBranch]].tree['src/math.js'];
  assertEquals(pushed, 'export const add = (a, b) => a + b;\n');
  assertEquals(stateOf(out).reviewRejections, 0, 'reset after a commit');
});

Deno.test(`after ${MAX_REVIEW_ROUNDS} held-back commits the agent may commit (no endless review loop)`, async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const commit = (n: number) => ({ calls: [{ name: 'commit_and_push', args: { message: `try ${n}` } }] });
  const model = scriptedModel(
    [{ calls: [PLAN, { name: 'write_file', args: { path: 'a.txt', content: 'y\n' } }] }, commit(1), commit(2), commit(3), { text: 'ok' }],
    [blocker('nope'), blocker('still nope'), blocker('never')],
  );
  const out = await events(await handleRequest(request({ ...base, message: 'go' }), { verify, fetchImpl: githubFetch(repo, model.handler) }));
  assertEquals(model.reviewsSeen.length, MAX_REVIEW_ROUNDS);
  assertEquals(toolResults(out, 'commit_and_push').map((r) => r.ok), [false, false, true]);
  assert(out.some((e) => e.type === 'status' && e.text.includes(`after ${MAX_REVIEW_ROUNDS} review rounds`)));
});

Deno.test('a reviewer that fails never blocks; minor notes reach the model with the commit result', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const script = () => [{ calls: [PLAN, { name: 'write_file', args: { path: 'a.txt', content: 'y\n' } }] }, { calls: [{ name: 'commit_and_push', args: { message: 'x -> y' } }] }, { text: 'ok' }];
  const broken = scriptedModel(script(), ['fail']);
  const out = await events(await handleRequest(request({ ...base, message: 'go' }), { verify, fetchImpl: githubFetch(repo, broken.handler) }));
  assertEquals(toolResults(out, 'commit_and_push')[0].ok, true);
  assertEquals(out.filter((e) => e.type === 'review').length, 0);

  const repo2 = fakeRepo({ 'a.txt': 'x\n' });
  const minor = scriptedModel(script(), [{ verdict: 'approve', issues: [{ severity: 'minor', problem: 'No trailing comment.' }] }]);
  await events(await handleRequest(request({ ...base, message: 'go' }), { verify, fetchImpl: githubFetch(repo2, minor.handler) }));
  assertStringIncludes(minor.seen[2].messages.at(-1).content, 'Reviewer notes (not blocking');

  // review: false turns it off.
  const repo3 = fakeRepo({ 'a.txt': 'x\n' });
  const off = scriptedModel(script());
  await events(await handleRequest(request({ ...base, message: 'go', review: false }), { verify, fetchImpl: githubFetch(repo3, off.handler) }));
  assertEquals(off.reviewsSeen.length, 0);
});

Deno.test({ name: 'mistakes and corrections are logged per user and repo, and shown at the start of later runs', ...pg, fn: async () => {
  const db = await testDb();
  const repo = fakeRepo({ 'old.txt': 'bye\n' });
  const model = scriptedModel([
    { calls: [PLAN, { name: 'delete_file', args: { path: 'old.txt' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Remove old.txt' } }] },
    { text: 'Left it.' },
  ], [blocker('Deleting old.txt breaks the import in main.js.', 'old.txt')]);
  const first = await events(await handleRequest(request({ ...base, message: 'remove old.txt' }), { verify, db, fetchImpl: githubFetch(repo, model.handler) }));
  assertEquals(first.find((e) => e.type === 'review').verdict, 'revise');

  // The user declines a later gated action with a reason.
  const again = scriptedModel([{ calls: [{ name: 'commit_and_push', args: { message: 'Remove old.txt anyway' } }] }, { text: 'ok' }], [{ verdict: 'approve', issues: [] }]);
  const asked = await events(await handleRequest(request({ ...base, continue: true, state: stateOf(first) }), { verify, db, fetchImpl: githubFetch(repo, again.handler) }));
  const ask = asked.find((e) => e.type === 'confirm');
  await events(await handleRequest(request({ ...base, continue: true, state: stateOf(asked), confirm: { id: ask.id, approve: false, note: 'we still need old.txt' } }), {
    verify, db, fetchImpl: githubFetch(repo, again.handler),
  }));

  const rows = await db.sql<any>('select kind, lesson from aro_agent_episodes where user_id = $1 and repo = $2 order by id', ['u1', 'acme/app']);
  assertEquals(rows.map((r: any) => r.kind), ['review', 'declined']);
  assertStringIncludes(rows[0].lesson, 'old.txt: Deleting old.txt breaks the import');
  assertStringIncludes(rows[1].lesson, 'they said: "we still need old.txt"');

  // A new session on the same repo starts with those lessons; another repo or user doesn't see them.
  const next = scriptedModel([{ text: 'ok' }]);
  await events(await handleRequest(request({ ...base, message: 'tidy up' }), { verify, db, fetchImpl: githubFetch(fakeRepo({}), next.handler) }));
  const system = next.seen[0].messages[0].content;
  assertStringIncludes(system, 'Notes from earlier runs in this repository');
  assertStringIncludes(system, 'we still need old.txt');
  assertEquals(await db.rpc('aro_agent_episodes_recent', { p_user: 'u1', p_repo: 'acme/other', p_limit: 8 }), []);
  assertEquals(await db.rpc('aro_agent_episodes_recent', { p_user: 'u2', p_repo: 'acme/app', p_limit: 8 }), []);

  // Capped at the newest 50 per user and repository.
  for (let i = 0; i < 55; i++) await db.rpc('aro_agent_episode_add', { p_user: 'u1', p_repo: 'acme/app', p_kind: 'loop', p_lesson: `loop ${i}` });
  const [{ n }] = await db.sql<any>("select count(*)::int as n from aro_agent_episodes where user_id = 'u1' and repo = 'acme/app'");
  assertEquals(n, 50);
  const recent = await db.rpc<any[]>('aro_agent_episodes_recent', { p_user: 'u1', p_repo: 'acme/app', p_limit: 3 });
  assertEquals(recent!.map((r) => r.lesson), ['loop 54', 'loop 53', 'loop 52']);
} });

// ------------------------------------------------------------------- chat

function chatRequest(body: unknown): Request {
  return new Request('http://localhost/ai-router', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

function sse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const LONG_CODE = '```python\n' + Array.from({ length: 35 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n```';

Deno.test('codeLines counts lines inside code blocks only', () => {
  assertEquals(codeLines('intro\n```js\na()\n\nb()\n```\noutro'), 2);
  assertEquals(codeLines(LONG_CODE), 35);
});

Deno.test({ name: 'long code answers in chat get a second check, appended to the answer', ...pg, fn: async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.tools?.[0]?.function?.name === 'submit_review') {
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'r', type: 'function', function: { name: 'submit_review', arguments: JSON.stringify({ verdict: 'revise', issues: [{ severity: 'blocker', problem: 'x34 is never used.' }] }) } }] } }] });
    }
    return sse(LONG_CODE);
  }) as typeof fetch;
  const deps = { verify: () => Promise.resolve({ uid: 'user-1' }), fetchImpl, db: await testDb(), env: (n: string) => ({ ARO_MODEL_BASE_URL: 'https://aro.example/v1' } as Record<string, string>)[n] };

  const text = await (await chat(chatRequest({ provider: 'aro', model: 'aro-1.5', messages: [{ role: 'user', content: 'Write the script' }] }), deps)).text();
  assertStringIncludes(text, 'Double-checking the code');
  assertStringIncludes(text, '**Second check**');
  assertStringIncludes(text, '**Must fix:** x34 is never used.');
  assertStringIncludes(bodies[1].messages.at(-1).content, 'The question:\nWrite the script');

  // Short answers are not reviewed; review: false turns it off.
  bodies.length = 0;
  const short = (async () => sse('Use `print()`.')) as typeof fetch;
  await (await chat(chatRequest({ provider: 'aro', model: 'aro-1.5', messages: [{ role: 'user', content: 'How do I print?' }] }), { ...deps, fetchImpl: short })).text();
  const off = await (await chat(chatRequest({ provider: 'aro', model: 'aro-1.5', review: false, messages: [{ role: 'user', content: 'Write it again' }] }), deps)).text();
  assert(!off.includes('Second check'));
  assertEquals(bodies.filter((b) => b.tools).length, 0);
} });
