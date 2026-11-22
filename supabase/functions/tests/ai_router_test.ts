import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleRequest, parseMessages } from '../ai-router/handler.ts';
import { rankClaude, rankGemini, rankOpenAI, rankQwen } from '../_shared/llm/list_models.ts';
import { resolveEndpoints } from '../_shared/llm/providers.ts';
import { readSseData } from '../_shared/http.ts';
import { testDb } from './pg.ts';

const user = { uid: 'user-1' };
const verifyOk = () => Promise.resolve(user);
const verifyFail = () => Promise.resolve(null);

function envOf(values: Record<string, string>) {
  return (name: string) => values[name];
}

function sse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function post(body: unknown): Request {
  return new Request('http://localhost/ai-router', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

async function frames(response: Response): Promise<any[]> {
  const out: any[] = [];
  for await (const payload of readSseData(response.body!)) {
    out.push(payload === '[DONE]' ? '[DONE]' : JSON.parse(payload));
  }
  return out;
}

Deno.test('rejects unauthenticated requests', async () => {
  const res = await handleRequest(post({ provider: 'aro', messages: [] }), { verify: verifyFail });
  assertEquals(res.status, 401);
});

Deno.test('rejects unknown providers', async () => {
  const res = await handleRequest(post({ provider: 'nope', messages: [{ role: 'user', content: 'hi' }] }), {
    verify: verifyOk,
  });
  assertEquals(res.status, 400);
});

Deno.test('BYOK provider without a key is a 400 with a helpful message', async () => {
  const res = await handleRequest(
    post({ provider: 'openai', model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] }),
    { verify: verifyOk },
  );
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).error, 'Settings → AI Providers');
});

const pgOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ name: 'ARO streams from the ARO server with its system prompt and meta frame', ...pgOpts, fn: async () => {
  let sentBody: any;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assertEquals(url, 'https://aro.example/v1/chat/completions');
    sentBody = JSON.parse(String(init.body));
    return sse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      '[DONE]',
    ]);
  }) as typeof fetch;

  const res = await handleRequest(
    post({ provider: 'aro', model: 'aro-1.5', messages: [{ role: 'user', content: 'hi' }], thinkingEnabled: true }),
    { verify: verifyOk, fetchImpl, db: await testDb(), env: envOf({ ARO_MODEL_BASE_URL: 'https://aro.example/v1/' }) },
  );
  const out = await frames(res);
  assertEquals(out[0].meta.servedBy, 'aro');
  assertEquals(out[0].meta.model, 'aro-1.5');
  assertEquals(out[0].meta.aroModel, 'aro-1.5');
  assertEquals(out[0].meta.usage, { plan: 'free', via: 'plan', limit: 50, remaining: 49, credits: null });
  assertEquals(out[1], { thinking: 'hmm' });
  assertEquals(out.slice(2), [{ delta: 'Hello' }, { delta: ' world' }, '[DONE]']);
  assertEquals(sentBody.messages[0].role, 'system');
  assertStringIncludes(sentBody.messages[0].content, 'ARO 1.5');
  assertEquals(sentBody.chat_template_kwargs, { enable_thinking: true });
} });

Deno.test({ name: 'ARO falls back when its server is down, before any output', ...pgOpts, fn: async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://aro.example')) throw new TypeError('connection refused');
    return sse([JSON.stringify({ choices: [{ delta: { content: 'from fallback' } }] }), '[DONE]']);
  }) as typeof fetch;

  const res = await handleRequest(post({ provider: 'aro', messages: [{ role: 'user', content: 'hi' }] }), {
    verify: verifyOk,
    fetchImpl,
    db: await testDb(),
    env: envOf({
      ARO_MODEL_BASE_URL: 'https://aro.example/v1',
      ARO_FALLBACK_BASE_URL: 'https://fallback.example/v1',
      ARO_FALLBACK_MODEL: 'backup-model',
    }),
  });
  const out = await frames(res);
  assertEquals(calls.length, 2);
  assertEquals([out[0].meta.servedBy, out[0].meta.model], ['fallback', 'backup-model']);
  assertEquals(out[1], { delta: 'from fallback' });
} });

Deno.test({ name: 'ARO without any configured server returns a clear 503 and does not charge', ...pgOpts, fn: async () => {
  const db = await testDb();
  const res = await handleRequest(post({ provider: 'aro', messages: [{ role: 'user', content: 'hi' }] }), {
    verify: verifyOk,
    db,
    env: envOf({}),
  });
  assertEquals(res.status, 503);
  const usage = await db.sql<{ requests: number }>("select requests from aro_usage_daily where user_id = 'user-1'");
  assertEquals(usage[0]?.requests ?? 0, 0);
} });

Deno.test('ARO is refused when the plans database is not configured', async () => {
  const res = await handleRequest(post({ provider: 'aro', messages: [{ role: 'user', content: 'hi' }] }), {
    verify: verifyOk,
    db: null,
    env: envOf({ ARO_MODEL_BASE_URL: 'https://aro.example/v1' }),
  });
  assertEquals(res.status, 503);
  assertStringIncludes((await res.json()).error, "plans aren't set up");
});

Deno.test('Claude streams text and thinking deltas, images become base64 blocks', async () => {
  let sentBody: any;
  let sentHeaders: Headers | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(String(init.body));
    sentHeaders = new Headers(init.headers);
    return sse([
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'plan' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'A cat.' } }),
    ]);
  }) as typeof fetch;

  const res = await handleRequest(
    post({
      provider: 'claude',
      model: 'claude-test',
      apiKey: 'sk-ant',
      thinkingEnabled: true,
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', mimeType: 'image/png', data: 'AAA' }] },
      ],
    }),
    { verify: verifyOk, fetchImpl },
  );
  const out = await frames(res);
  assertEquals(out.slice(1, 3), [{ thinking: 'plan' }, { delta: 'A cat.' }]);
  assertEquals(sentHeaders?.get('x-api-key'), 'sk-ant');
  assertEquals(sentBody.system, 'be nice');
  assertEquals(sentBody.thinking.type, 'enabled');
  assertEquals(sentBody.messages[0].content[1].source, { type: 'base64', media_type: 'image/png', data: 'AAA' });
});

Deno.test('Gemini uses the native API with the key in a header, not the URL', async () => {
  let sentUrl = '';
  let sentHeaders: Headers | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sentUrl = url;
    sentHeaders = new Headers(init.headers);
    return sse([
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'think', thought: true }, { text: 'answer' }] } }] }),
    ]);
  }) as typeof fetch;

  const res = await handleRequest(
    post({ provider: 'gemini', model: 'gemini-x', apiKey: 'g-key', messages: [{ role: 'user', content: 'hi' }] }),
    { verify: verifyOk, fetchImpl },
  );
  const out = await frames(res);
  assert(!sentUrl.includes('g-key'));
  assertEquals(sentHeaders?.get('x-goog-api-key'), 'g-key');
  assertEquals(out.slice(1, 3), [{ thinking: 'think' }, { delta: 'answer' }]);
});

Deno.test('upstream errors are reported as an SSE error frame', async () => {
  const fetchImpl = (async () => new Response('bad key', { status: 401 })) as typeof fetch;
  const res = await handleRequest(
    post({ provider: 'openai', model: 'gpt-x', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }] }),
    { verify: verifyOk, fetchImpl },
  );
  const out = await frames(res);
  assertStringIncludes(out[0].error, '401');
  assertEquals(out.at(-1), '[DONE]');
});

Deno.test('listModels ranks and filters a provider list', async () => {
  const fetchImpl = (async () =>
    Response.json({
      data: [{ id: 'gpt-4o-mini-tts' }, { id: 'gpt-5.6' }, { id: 'text-embedding-3' }, { id: 'o4-mini' }],
    })) as typeof fetch;
  const res = await handleRequest(post({ action: 'listModels', provider: 'openai', apiKey: 'k' }), {
    verify: verifyOk,
    fetchImpl,
  });
  assertEquals((await res.json()).models, ['gpt-5.6', 'o4-mini']);
});

Deno.test('ranking helpers', () => {
  assertEquals(rankClaude(['claude-haiku-4', 'claude-opus-5', 'claude-sonnet-5', 'other']), [
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-haiku-4',
  ]);
  assertEquals(rankGemini(['gemini-3-flash', 'text-embedding', 'gemini-3-pro', 'gemini-3-flash-lite']), [
    'gemini-3-pro',
    'gemini-3-flash',
    'gemini-3-flash-lite',
  ]);
  assertEquals(rankQwen(['qwen-plus', 'qwen-vl-max', 'qwen3-max'], 'chat'), ['qwen3-max', 'qwen-plus']);
  assertEquals(rankQwen(['qwen-plus', 'qwen-vl-max', 'qwen-vl-plus'], 'vision'), ['qwen-vl-max', 'qwen-vl-plus']);
  assertEquals(rankOpenAI(['dall-e-3', 'gpt-5']), ['gpt-5']);
});

Deno.test('agent purpose sends Gemini through its OpenAI-compatible API', () => {
  const [endpoint] = resolveEndpoints('gemini', 'gemini-x', 'k', 'agent', envOf({}));
  assertEquals(endpoint.kind, 'openai');
  assertStringIncludes(endpoint.baseUrl, '/openai');
});

Deno.test('parseMessages validates input', () => {
  assertEquals(typeof parseMessages([]), 'string');
  assertEquals(typeof parseMessages([{ role: 'robot', content: 'x' }]), 'string');
  assertEquals(typeof parseMessages([{ role: 'user', content: [{ type: 'image', mimeType: 'text/html', data: 'x' }] }]), 'string');
  assertEquals(parseMessages([{ role: 'user', content: 'ok' }]), [{ role: 'user', content: 'ok' }]);
});
