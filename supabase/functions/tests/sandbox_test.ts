// Phase 4: real execution — the agent runs commands and Python in the RunPod
// sandbox, and the repository's tests run on the staged changes before every
// commit (failing tests hold the commit back).

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleRequest, MAX_TEST_ROUNDS } from '../aro-agent/handler.ts';
import { ToolRunner } from '../aro-agent/tools.ts';
import { createState } from '../aro-agent/state.ts';
import { GitHubClient } from '../_shared/github.ts';
import { toolchainsFor } from '../_shared/sandbox.ts';
import { base, events, fakeRepo, githubFetch, PLAN, request, scriptedModel, verify } from './agent_harness.ts';
import { testDb } from './pg.ts';

const SANDBOX_ENV: Record<string, string> = { SANDBOX_URL: 'https://sandbox.example/v2/sb1', ARO_MODEL_API_KEY: 'rp_key' };
const env = (extra: Record<string, string> = {}) => (n: string) => ({ ...SANDBOX_ENV, ...extra } as Record<string, string>)[n];
const stateOf = (out: any[]) => out.find((e) => e.type === 'state').state;
const toolResults = (out: any[], name: string) => out.filter((e) => e.type === 'tool_result' && e.name === name);

type Job = { input: any; polls: number };
/** A fake RunPod queue endpoint: `run` decides each job's result from its input. */
function fakeSandbox(run: (input: any) => { exit_code: number; output: string } | { error: string }, pollsUntilDone = 0) {
  const jobs = new Map<string, Job>();
  const requests: { url: string; auth: string | null; body?: any }[] = [];
  let n = 0;
  const handle = (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get('authorization');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, auth, body });
    if (url.endsWith('/run')) {
      const id = `job-${String(++n).padStart(4, '0')}`;
      jobs.set(id, { input: body.input, polls: 0 });
      return Response.json({ id, status: 'IN_QUEUE' });
    }
    const id = url.split('/status/')[1];
    const job = jobs.get(id)!;
    if (job.polls++ < pollsUntilDone) return Response.json({ id, status: 'IN_PROGRESS' });
    const out = run(job.input);
    return Response.json({ id, status: 'COMPLETED', output: 'error' in out ? out : { ...out, timed_out: false, duration_ms: 1200, setup: '' } });
  };
  return { handle, requests, jobs: () => [...jobs.values()].map((j) => j.input) };
}

function fetchWith(repo: ReturnType<typeof fakeRepo>, model: ReturnType<typeof scriptedModel>, sandbox: ReturnType<typeof fakeSandbox>) {
  const gh = githubFetch(repo, model.handler);
  return (async (url: string, init?: RequestInit) => (url.startsWith('https://sandbox.example/') ? sandbox.handle(url, init) : gh(url, init))) as typeof fetch;
}

const PKG = JSON.stringify({ name: 'app', scripts: { test: 'node test.js' } });
const npmRepo = () => fakeRepo({ 'package.json': PKG, 'package-lock.json': '{}', 'src/math.js': 'exports.add = (a, b) => a - b;\n', 'test.js': 'assert(add(2,3)===5)' });
/** "Runs the tests": they pass only when the staged math.js really adds. */
const npmTests = (input: any) =>
  String(input.files?.['src/math.js'] ?? '').includes('a + b')
    ? { exit_code: 0, output: '1 passing' }
    : { exit_code: 1, output: 'AssertionError: expected 5, got -1\n1 failing' };

Deno.test('toolchains are installed only when the command needs them', () => {
  assertEquals(toolchainsFor('npm ci && npm test'), ['node']);
  assertEquals(toolchainsFor('cd api && go test ./...'), ['go']);
  assertEquals(toolchainsFor('pytest -q'), []);
});

Deno.test('sandbox tools are offered only when the sandbox is configured', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const off = scriptedModel([{ text: 'ok' }]);
  await events(await handleRequest(request({ ...base, message: 'hi' }), { verify, fetchImpl: githubFetch(repo, off.handler) }));
  const names = (b: any) => b.tools.map((t: any) => t.function.name);
  assert(!names(off.seen[0]).includes('run_in_sandbox'));
  assertStringIncludes(off.seen[0].messages[0].content, 'You cannot run code');

  const on = scriptedModel([{ text: 'ok' }]);
  await events(await handleRequest(request({ ...base, message: 'hi' }), { verify, env: env(), fetchImpl: fetchWith(repo, on, fakeSandbox(npmTests)) }));
  assert(['run_in_sandbox', 'run_python', 'sandbox_result'].every((n) => names(on.seen[0]).includes(n)));
  assertStringIncludes(on.seen[0].messages[0].content, 'You can run code');
});

Deno.test('run_in_sandbox runs on the working branch plus staged changes, without the GitHub token', async () => {
  const repo = npmRepo();
  const sandbox = fakeSandbox(npmTests);
  const model = scriptedModel([
    { calls: [PLAN, { name: 'edit_file', args: { path: 'src/math.js', old_text: 'a - b', new_text: 'a + b' } }] },
    { calls: [{ name: 'run_in_sandbox', args: { command: 'npm ci && npm test', timeout_seconds: 120 } }] },
    { text: 'Tests pass.' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'fix add' }), { verify, env: env(), fetchImpl: fetchWith(repo, model, sandbox) }));
  const [job] = sandbox.jobs();
  assertEquals(job.mode, 'repo');
  assertEquals(job.repo_url, 'https://codeload.example/acme/app/tar.gz/main?token=SHORTLIVED');
  assertEquals(job.files, { 'src/math.js': 'exports.add = (a, b) => a + b;\n' });
  assertEquals(job.toolchains, ['node']);
  const run = sandbox.requests.find((r) => r.url.endsWith('/run'))!;
  assertEquals(run.auth, 'Bearer rp_key');
  assert(!JSON.stringify(sandbox.requests).includes('github_pat_test'), 'the GitHub token never reaches the sandbox');
  assertStringIncludes(model.seen[2].messages.at(-1).content, 'finished with exit code 0');
  assertStringIncludes(model.seen[2].messages.at(-1).content, '1 passing');
  assertEquals(stateOf(out).sandboxJobs, ['job-0001']);
});

Deno.test({ name: 'failing tests hold the commit back; once fixed, the commit goes through with a passing test note', sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const db = await testDb();
  const repo = npmRepo();
  const sandbox = fakeSandbox(npmTests);
  const model = scriptedModel([
    { calls: [PLAN, { name: 'write_file', args: { path: 'src/math.js', content: 'exports.add = (a, b) => a * b;\n' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Fix add' } }] },
    { calls: [{ name: 'write_file', args: { path: 'src/math.js', content: 'exports.add = (a, b) => a + b;\n' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Fix add' } }] },
    { text: 'Fixed and tested.' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'fix add' }), { verify, db, env: env(), fetchImpl: fetchWith(repo, model, sandbox) }));
  const verifies = out.filter((e) => e.type === 'verify');
  assertEquals(verifies.map((v) => [v.ok, v.label]), [[false, 'npm test'], [true, 'npm test']]);
  assertStringIncludes(verifies[0].summary, '1 failing');
  const commits = toolResults(out, 'commit_and_push');
  assertEquals(commits.map((c) => c.ok), [false, true]);
  assertStringIncludes(commits[0].summary, "Not committed: the repository's tests failed");
  assertStringIncludes(model.seen[2].messages.at(-1).content, 'AssertionError: expected 5, got -1');
  assertEquals(sandbox.jobs().map((j) => j.command), ['npm ci --no-audit --no-fund && npm test', 'npm ci --no-audit --no-fund && npm test']);
  assertStringIncludes(model.reviewsSeen[0].messages.at(-1).content, 'Test run: Tests (npm test) passed on these changes.');
  assertStringIncludes(model.seen[4].messages.at(-1).content, 'Tests (npm test) passed on these changes.');
  assertEquals(repo.commits[repo.branches[stateOf(out).workBranch]].tree['src/math.js'], 'exports.add = (a, b) => a + b;\n');
  assertEquals(stateOf(out).testFailures, 0);
  const [episode] = await db.sql<any>("select kind, lesson from aro_agent_episodes where user_id = 'u1'");
  assertEquals(episode.kind, 'tests');
  assertStringIncludes(episode.lesson, '1 failing');
} });

Deno.test(`after ${MAX_TEST_ROUNDS} failed test runs the agent may commit (no endless loop)`, async () => {
  const repo = npmRepo();
  const sandbox = fakeSandbox(() => ({ exit_code: 1, output: 'flaky failure' }));
  const commit = (n: number) => ({ calls: [{ name: 'commit_and_push', args: { message: `try ${n}` } }] });
  const model = scriptedModel([{ calls: [PLAN, { name: 'write_file', args: { path: 'x.txt', content: 'x' } }] }, commit(1), commit(2), commit(3), { text: 'ok' }]);
  const out = await events(await handleRequest(request({ ...base, message: 'go' }), { verify, env: env(), fetchImpl: fetchWith(repo, model, sandbox) }));
  assertEquals(toolResults(out, 'commit_and_push').map((c) => c.ok), [false, false, true]);
  assertEquals(sandbox.jobs().length, MAX_TEST_ROUNDS);
  assert(out.some((e) => e.type === 'status' && e.text.includes(`failed ${MAX_TEST_ROUNDS} times`)));
});

Deno.test('tests still running: the commit waits, sandbox_result collects them, then the commit goes through without a re-run', async () => {
  const repo = npmRepo();
  const sandbox = fakeSandbox(npmTests, 3);
  const fix = { name: 'write_file', args: { path: 'src/math.js', content: 'exports.add = (a, b) => a + b;\n' } };
  const model = scriptedModel([
    { calls: [PLAN, fix] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Fix add' } }] },
    { calls: [{ name: 'sandbox_result', args: { job_id: 'job-0001' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Fix add' } }] },
    { text: 'done' },
  ]);
  // A short time budget, so the first wait ends before the job does.
  const out = await events(await handleRequest(request({ ...base, message: 'fix' }), {
    verify, env: env({ AGENT_TIME_BUDGET_MS: '16000' }), fetchImpl: fetchWith(repo, model, sandbox),
  }));
  const commits = toolResults(out, 'commit_and_push');
  assertStringIncludes(commits[0].summary, 'still running (job job-0001)');
  assertEquals(toolResults(out, 'sandbox_result')[0].ok, true);
  assertEquals(commits[1].ok, true);
  assertEquals(sandbox.jobs().length, 1, 'the collected result counts: no second test run');
});

Deno.test('sandbox_result only collects jobs from this session; run_python sends no repository', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const sandbox = fakeSandbox((input) => ({ exit_code: 0, output: input.mode === 'python' ? '3628800' : '?' }));
  const model = scriptedModel([
    { calls: [{ name: 'sandbox_result', args: { job_id: 'someone-elses-job' } }] },
    { calls: [{ name: 'run_python', args: { code: 'import math\nprint(math.factorial(10))' } }] },
    { text: 'ok' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'compute' }), { verify, env: env(), fetchImpl: fetchWith(repo, model, sandbox) }));
  assertStringIncludes(toolResults(out, 'sandbox_result')[0].summary, 'Unknown sandbox job');
  const [job] = sandbox.jobs();
  assertEquals([job.mode, job.repo_url, job.code], ['python', undefined, 'import math\nprint(math.factorial(10))']);
  assertStringIncludes(model.seen[2].messages.at(-1).content, '3628800');
});

Deno.test('no standard test command: commits are not delayed by the sandbox', async () => {
  const repo = fakeRepo({ 'README.md': '# hi\n' });
  const sandbox = fakeSandbox(npmTests);
  const model = scriptedModel([{ calls: [PLAN, { name: 'write_file', args: { path: 'README.md', content: '# hello\n' } }] }, { calls: [{ name: 'commit_and_push', args: { message: 'Docs' } }] }, { text: 'ok' }]);
  const out = await events(await handleRequest(request({ ...base, message: 'docs' }), { verify, env: env(), fetchImpl: fetchWith(repo, model, sandbox) }));
  assertEquals(toolResults(out, 'commit_and_push')[0].ok, true);
  assertEquals(sandbox.jobs().length, 0);
});

Deno.test('test detection: npm, yarn, pnpm, pytest and go', async () => {
  const detect = async (files: Record<string, string>, pending: Record<string, string | null> = {}) => {
    const repo = fakeRepo(files);
    const state = createState('acme', 'app', 'main', 'branch', 'x');
    state.pending = pending;
    const runner = new ToolRunner(new GitHubClient('t', 'acme', 'app', githubFetch(repo, () => ({}))), state, () => {});
    return (await runner.detectTests())?.label ?? null;
  };
  assertEquals(await detect({ 'package.json': PKG, 'yarn.lock': '' }), 'yarn test');
  assertEquals(await detect({ 'package.json': PKG, 'pnpm-lock.yaml': '' }), 'pnpm test');
  assertEquals(await detect({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), null);
  assertEquals(await detect({ 'src/app.py': '', 'tests/test_app.py': '' }), 'pytest');
  assertEquals(await detect({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }), 'pytest');
  assertEquals(await detect({ 'go.mod': 'module x\n' }), 'go test');
  assertEquals(await detect({ 'README.md': '' }, { 'package.json': PKG }), 'npm test', 'a staged package.json counts');
  assertEquals(await detect({ 'README.md': '' }), null);
});
