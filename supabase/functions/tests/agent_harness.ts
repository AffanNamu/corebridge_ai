// Shared test helpers for the coding agent: a fake GitHub API and a scripted model.

import { assertEquals } from 'jsr:@std/assert@1';
import { readSseData } from '../_shared/http.ts';

// ------------------------------------------------------------ fake GitHub

export interface FakeRepo {
  branches: Record<string, string>; // branch -> commit sha
  commits: Record<string, { tree: Record<string, string>; parents: string[]; message: string }>;
  pulls: { head: string; base: string; title: string; body: string }[];
  canPush: boolean;
}

export function fakeRepo(files: Record<string, string>): FakeRepo {
  return {
    branches: { main: 'c0' },
    commits: { c0: { tree: files, parents: [], message: 'init' } },
    pulls: [],
    canPush: true,
  };
}

export function githubFetch(repo: FakeRepo, onModel: (body: any) => any) {
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
export function scriptedModel(script: { text?: string; calls?: { name: string; args: unknown }[] }[]) {
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

export function request(body: unknown): Request {
  return new Request('http://localhost/aro-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer firebase' },
    body: JSON.stringify(body),
  });
}

export async function events(response: Response): Promise<any[]> {
  const out: any[] = [];
  for await (const payload of readSseData(response.body!)) {
    if (payload !== '[DONE]') out.push(JSON.parse(payload));
  }
  return out;
}

export const verify = () => Promise.resolve({ uid: 'u1' });
export const base = {
  provider: 'openai',
  model: 'gpt-test',
  apiKey: 'sk-test',
  githubToken: 'github_pat_test',
  repo: { owner: 'acme', name: 'app' },
};

