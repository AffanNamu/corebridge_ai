import { assert, assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1';
import { handleRequest } from '../aro-agent/handler.ts';
import { compactTranscript, createState, newWorkBranch, parseState } from '../aro-agent/state.ts';
import { findSecrets, safePath } from '../aro-agent/tools.ts';
import { readSseData } from '../_shared/http.ts';
import { testDb } from './pg.ts';
import { toAnthropicMessages, toOpenAIMessages, type AgentMessage } from '../_shared/llm/tool_chat.ts';

// ------------------------------------------------------------ fake GitHub

interface FakeRepo {
  branches: Record<string, string>; // branch -> commit sha
  commits: Record<string, { tree: Record<string, string>; parents: string[]; message: string }>;
  pulls: { head: string; base: string; title: string; body: string }[];
  canPush: boolean;
}

function fakeRepo(files: Record<string, string>): FakeRepo {
  return {
    branches: { main: 'c0' },
    commits: { c0: { tree: files, parents: [], message: 'init' } },
    pulls: [],
    canPush: true,
  };
}

function githubFetch(repo: FakeRepo, onModel: (body: any) => any) {
  let seq = 0;
  const trees: Record<string, Record<string, string>> = {};
  return (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    if (url.hostname !== 'api.github.com') return Response.json(onModel(body));

    const path = url.pathname.replace('/repos/acme/app', '');
    if (path === '' && method === 'GET') {
      return Response.json({ default_branch: 'main', private: true, permissions: { push: repo.canPush } });
    }
    let m = path.match(/^\/git\/ref\/heads\/(.+)$/);
    if (m) {
      const sha = repo.branches[decodeURIComponent(m[1])];
      return sha ? Response.json({ object: { sha } }) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (path === '/git/refs' && method === 'POST') {
      repo.branches[body.ref.replace('refs/heads/', '')] = body.sha;
      return Response.json({}, { status: 201 });
    }
    m = path.match(/^\/git\/trees\/(.+)$/);
    if (m && method === 'GET') {
      const ref = decodeURIComponent(m[1]);
      const tree = repo.commits[repo.branches[ref] ?? ref].tree;
      return Response.json({
        tree: Object.keys(tree).map((p) => ({ path: p, mode: p.endsWith('.sh') ? '100755' : '100644', type: 'blob', sha: 'x' })),
        truncated: false,
      });
    }
    m = path.match(/^\/contents\/(.+)$/);
    if (m) {
      const ref = url.searchParams.get('ref')!;
      const content = repo.commits[repo.branches[ref]].tree[decodeURIComponent(m[1])];
      return content === undefined ? new Response('{"message":"Not Found"}', { status: 404 }) : new Response(content);
    }
    m = path.match(/^\/git\/commits\/(.+)$/);
    if (m && method === 'GET') return Response.json({ tree: { sha: `tree-of-${m[1]}` } });
    if (path === '/git/trees' && method === 'POST') {
      const baseCommit = body.base_tree.replace('tree-of-', '');
      const next = { ...repo.commits[baseCommit].tree };
      for (const entry of body.tree) {
        if (entry.sha === null) delete next[entry.path];
        else next[entry.path] = entry.content;
      }
      const sha = `t${++seq}`;
      trees[sha] = next;
      return Response.json({ sha });
    }
    if (path === '/git/commits' && method === 'POST') {
      const sha = `c${++seq}`;
      repo.commits[sha] = { tree: trees[body.tree], parents: body.parents, message: body.message };
      return Response.json({ sha });
    }
    m = path.match(/^\/git\/refs\/heads\/(.+)$/);
    if (m && method === 'PATCH') {
      assertEquals(body.force, false);
      repo.branches[decodeURIComponent(m[1])] = body.sha;
      return Response.json({});
    }
    if (path === '/pulls' && method === 'POST') {
      repo.pulls.push(body);
      return Response.json({ number: 7, html_url: 'https://github.com/acme/app/pull/7' });
    }
    return Response.json({ message: `unhandled ${method} ${path}` }, { status: 500 });
  }) as typeof fetch;
}

/** Fake OpenAI-compatible model that plays back a script of tool calls. */
function scriptedModel(script: { text?: string; calls?: { name: string; args: unknown }[] }[]) {
  let turn = 0;
  const seen: any[] = [];
  const handler = (body: any) => {
    seen.push(body);
    const step = script[turn++] ?? { text: 'done' };
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: step.text ?? null,
          tool_calls: (step.calls ?? []).map((c, i) => ({
            id: `call_${turn}_${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      }],
    };
  };
  return { handler, seen };
}

function request(body: unknown): Request {
  return new Request('http://localhost/aro-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer firebase' },
    body: JSON.stringify(body),
  });
}

async function events(response: Response): Promise<any[]> {
  const out: any[] = [];
  for await (const payload of readSseData(response.body!)) {
    if (payload !== '[DONE]') out.push(JSON.parse(payload));
  }
  return out;
}

const verify = () => Promise.resolve({ uid: 'u1' });
const base = {
  provider: 'openai',
  model: 'gpt-test',
  apiKey: 'sk-test',
  githubToken: 'github_pat_test',
  repo: { owner: 'acme', name: 'app' },
};

// ------------------------------------------------------------------ tests

Deno.test('agent fixes a bug, pushes one commit to a new branch and opens a PR', async () => {
  const repo = fakeRepo({ 'src/math.js': 'export const add = (a, b) => a - b;\n', 'run.sh': 'echo hi\n' });
  const model = scriptedModel([
    { calls: [{ name: 'list_files', args: {} }] },
    { calls: [{ name: 'read_file', args: { path: 'src/math.js' } }] },
    { text: 'Found it.', calls: [{ name: 'edit_file', args: { path: 'src/math.js', old_text: 'a - b', new_text: 'a + b' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'Fix add() to sum its arguments' } }] },
    { calls: [{ name: 'create_pull_request', args: { title: 'Fix add()', body: 'add() subtracted.' } }] },
    { text: 'Fixed add() in src/math.js and opened PR #7.' },
  ]);

  const res = await handleRequest(request({ ...base, message: 'add() returns wrong results' }), {
    verify,
    fetchImpl: githubFetch(repo, model.handler),
  });
  const out = await events(res);

  const commit = out.find((e) => e.type === 'commit');
  assert(commit, 'commit event');
  assert(commit.branch.startsWith('aro/add-returns-wrong-results-'));
  assertEquals(commit.files, ['src/math.js']);
  assertEquals(repo.commits[repo.branches[commit.branch]].tree['src/math.js'], 'export const add = (a, b) => a + b;\n');
  assertEquals(repo.branches.main, 'c0', 'base branch untouched');

  assertEquals(repo.pulls.length, 1);
  assertEquals(repo.pulls[0].base, 'main');
  assertStringIncludes(repo.pulls[0].body, 'Opened by ARO AI');
  assert(out.find((e) => e.type === 'pull_request'));

  const state = out.find((e) => e.type === 'state').state;
  assertEquals(state.pending, {});
  assertEquals(state.commits.length, 1);
  assertEquals(out.at(-1), { type: 'done', status: 'completed' });
  assertEquals(out.filter((e) => e.type === 'text').at(-1).text, 'Fixed add() in src/math.js and opened PR #7.');

  // Tool results reach the model: the file list, then the numbered file.
  const toolMsg = model.seen[2].messages.find((m: any) => m.role === 'tool');
  assertStringIncludes(toolMsg.content, 'src/math.js');
  assertStringIncludes(model.seen[2].messages.at(-1).content, '    1  export const add');
});

Deno.test('session state round-trips: a follow-up message continues on the same branch', async () => {
  const repo = fakeRepo({ 'a.txt': 'one\n' });
  const first = scriptedModel([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'two\n' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'one -> two' } }] },
    { text: 'Done.' },
  ]);
  const out1 = await events(await handleRequest(request({ ...base, message: 'change a' }), {
    verify,
    fetchImpl: githubFetch(repo, first.handler),
  }));
  const state = out1.find((e) => e.type === 'state').state;

  const second = scriptedModel([
    { calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'three\n' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'two -> three' } }] },
    { text: 'Done again.' },
  ]);
  const out2 = await events(await handleRequest(request({ ...base, message: 'now three', state }), {
    verify,
    fetchImpl: githubFetch(repo, second.handler),
  }));
  const readResult = second.seen[1].messages.at(-1).content;
  assertStringIncludes(readResult, 'two', 'reads from the working branch, not main');
  const state2 = out2.find((e) => e.type === 'state').state;
  assertEquals(state2.workBranch, state.workBranch);
  assertEquals(state2.commits.length, 2);
  assertEquals(repo.commits[repo.branches[state.workBranch]].tree['a.txt'], 'three\n');
});

Deno.test('direct push mode commits to the base branch', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const model = scriptedModel([
    { calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'y\n' } }, { name: 'commit_and_push', args: { message: 'x -> y' } }] },
    { text: 'ok' },
  ]);
  await events(await handleRequest(request({ ...base, message: 'go', pushMode: 'direct' }), {
    verify,
    fetchImpl: githubFetch(repo, model.handler),
  }));
  assertEquals(repo.commits[repo.branches.main].tree['a.txt'], 'y\n');
});

Deno.test('secrets are never committed', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const model = scriptedModel([
    { calls: [{ name: 'write_file', args: { path: 'config.js', content: 'const key = "sk-proj-' + 'a'.repeat(40) + '";' } }] },
    { calls: [{ name: 'commit_and_push', args: { message: 'add key' } }] },
    { text: 'could not commit' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'add my key' }), {
    verify,
    fetchImpl: githubFetch(repo, model.handler),
  }));
  const result = out.find((e) => e.type === 'tool_result' && e.name === 'commit_and_push');
  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, 'secrets');
  assertEquals(Object.keys(repo.branches), ['main']);
});

Deno.test('a token without push access is rejected up front', async () => {
  const repo = fakeRepo({});
  repo.canPush = false;
  const res = await handleRequest(request({ ...base, message: 'hi' }), {
    verify,
    fetchImpl: githubFetch(repo, () => ({})),
  });
  assertEquals(res.status, 403);
});

Deno.test('missing GitHub token or bad repo name is a 400', async () => {
  const noToken = await handleRequest(request({ ...base, githubToken: '', message: 'x' }), { verify });
  assertEquals(noToken.status, 400);
  const badRepo = await handleRequest(request({ ...base, repo: { owner: '../x', name: 'app' }, message: 'x' }), { verify });
  assertEquals(badRepo.status, 400);
});

Deno.test('runs pause at the time budget and can continue', async () => {
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const model = scriptedModel([
    { calls: [{ name: 'list_files', args: {} }] },
    { calls: [{ name: 'list_files', args: {} }] },
    { text: 'finished' },
  ]);
  let clock = 0;
  const out = await events(await handleRequest(request({ ...base, message: 'look around' }), {
    verify,
    fetchImpl: githubFetch(repo, model.handler),
    env: (n) => (n === 'AGENT_TIME_BUDGET_MS' ? '1000' : undefined),
    now: () => (clock += 600),
  }));
  assertEquals(out.at(-1), { type: 'done', status: 'paused' });
  const state = out.find((e) => e.type === 'state').state;

  const out2 = await events(await handleRequest(request({ ...base, continue: true, state }), {
    verify,
    fetchImpl: githubFetch(repo, model.handler),
  }));
  assertEquals(out2.at(-1), { type: 'done', status: 'completed' });
});

Deno.test('edit_file reports helpful errors', async () => {
  const repo = fakeRepo({ 'a.txt': 'same\nsame\n' });
  const model = scriptedModel([
    { calls: [{ name: 'edit_file', args: { path: 'a.txt', old_text: 'same', new_text: 'x' } }, { name: 'edit_file', args: { path: 'a.txt', old_text: 'nope', new_text: 'x' } }, { name: 'read_file', args: { path: '../etc/passwd' } }] },
    { text: 'ok' },
  ]);
  const out = await events(await handleRequest(request({ ...base, message: 'edit' }), {
    verify,
    fetchImpl: githubFetch(repo, model.handler),
  }));
  const results = out.filter((e) => e.type === 'tool_result');
  assertStringIncludes(results[0].summary, 'appears 2 times');
  assertStringIncludes(results[1].summary, 'was not found');
  assertStringIncludes(results[2].summary, 'Invalid path');
});

Deno.test({ name: 'ARO runs the agent as ARO Code on Pro, and as ARO 1.5 (with a notice) on Free', sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const db = await testDb();
  const repo = fakeRepo({ 'a.txt': 'x\n' });
  const run = async () => {
    const models: string[] = [];
    const inner = githubFetch(repo, (body: any) => {
      models.push(body.model);
      return { choices: [{ message: { role: 'assistant', content: `Hello from ${body.model}` } }] };
    });
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      if (!input.includes('api.github.com')) assertEquals(input, 'https://aro.example/v1/chat/completions');
      return await inner(input, init);
    }) as typeof fetch;
    const out = await events(await handleRequest(request({ ...base, provider: 'aro', apiKey: undefined, message: 'hi' }), {
      verify,
      fetchImpl,
      db,
      env: (n) => ({ ARO_MODEL_BASE_URL: 'https://aro.example/v1' } as Record<string, string>)[n],
    }));
    return { models, out };
  };

  const free = await run();
  assertEquals(free.models, ['aro-1.5']);
  assertStringIncludes(free.out.find((e) => e.type === 'status' && e.text.includes('ARO 1.5 is working')).text, "ARO Code isn't included in Free");
  assertEquals(free.out.find((e) => e.type === 'text').text, 'Hello from aro-1.5');

  await db.rpc('aro_admin_grant_plan', { p_admin: 'admin', p_user: 'u1', p_plan: 'pro', p_days: 30 });
  const pro = await run();
  assertEquals(pro.models, ['aro-code']);
  assertEquals(pro.out.find((e) => e.type === 'model').aroModel, 'aro-code');
} });

Deno.test('path safety and secret detection', () => {
  assertEquals(safePath('./src/a.ts'), 'src/a.ts');
  for (const bad of ['/etc/passwd', '../x', 'a/../b', '.git/config', 'a//b', '']) {
    assertThrows(() => safePath(bad));
  }
  assertEquals(findSecrets({ '.env': 'A=1', '.env.example': 'A=', 'ok.ts': 'const x = 1', 'gone.ts': null }), ['.env']);
  assertEquals(findSecrets({ 'k.ts': '-----BEGIN PRIVATE KEY-----' }), ['k.ts']);
});

Deno.test('state helpers', () => {
  assertEquals(newWorkBranch('Fix: login crash!!', 1_700_000_000_000).startsWith('aro/fix-login-crash-'), true);
  const s = createState('acme', 'app', 'main', 'branch', 'task');
  assertEquals(typeof parseState(s), 'object');
  assertEquals(typeof parseState({ ...s, workBranch: 'main' }), 'string');
  assertEquals(typeof parseState({ ...s, baseBranch: '../evil' }), 'string');

  const big = 'x'.repeat(5000);
  const transcript: AgentMessage[] = [
    { role: 'user', text: 'task' },
    ...Array.from({ length: 10 }, (_, i) => [
      { role: 'assistant' as const, text: '', toolCalls: [{ id: `${i}`, name: 'read_file', args: {} }] },
      { role: 'tool' as const, results: [{ id: `${i}`, name: 'read_file', content: big }] },
    ]).flat(),
  ];
  const compacted = compactTranscript(transcript);
  const first = compacted[2] as Extract<AgentMessage, { role: 'tool' }>;
  assert(first.results[0].content.length < 2000);
  const last = compacted.at(-1) as Extract<AgentMessage, { role: 'tool' }>;
  assertEquals(last.results[0].content.length, 5000);
});

Deno.test('transcript converts to Anthropic and OpenAI formats', () => {
  const transcript: AgentMessage[] = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'look', toolCalls: [{ id: 't1', name: 'list_files', args: {} }] },
    { role: 'tool', results: [{ id: 't1', name: 'list_files', content: 'a.txt', isError: true }] },
  ];
  const anthropic = toAnthropicMessages(transcript) as any[];
  assertEquals(anthropic[1].content[1], { type: 'tool_use', id: 't1', name: 'list_files', input: {} });
  assertEquals(anthropic[2].content[0], { type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: true });

  const openai = toOpenAIMessages('sys', transcript) as any[];
  assertEquals(openai[0], { role: 'system', content: 'sys' });
  assertEquals(openai[2].tool_calls[0].function.name, 'list_files');
  assertEquals(openai[3], { role: 'tool', tool_call_id: 't1', content: 'ERROR: a.txt' });
});
