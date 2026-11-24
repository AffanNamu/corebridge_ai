// A missing or failing ARO adapter (e.g. "aro-code" before it is published)
// must fall back to ARO 1.5 instead of showing the user an error.

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { streamWithFallback } from '../ai-router/handler.ts';
import { aroEndpoints } from '../_shared/aro.ts';
import { chatWithTools } from '../_shared/llm/tool_chat.ts';
import { ProviderError } from '../_shared/llm/types.ts';

const env = (n: string) => ({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', ARO_MODEL_API_KEY: 'k' } as Record<string, string>)[n];
const sse = (lines: unknown[]) =>
  new Response(lines.map((l) => `data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

Deno.test('chat: an ARO adapter that fails inside the stream falls back to ARO 1.5', async () => {
  const models: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { model } = JSON.parse(String(init.body));
    models.push(model);
    return model === 'aro-code'
      ? sse([{ error: 'the worker failed this request' }])
      : sse([{ choices: [{ delta: { content: 'def add(a, b): return a + b' } }] }, '[DONE]']);
  }) as typeof fetch;
  const frames: string[] = [];
  const result = await streamWithFallback(aroEndpoints('text', 'aro-code', env), [{ role: 'user', content: 'write add()' }], false, fetchImpl,
    (f) => frames.push(new TextDecoder().decode(f)));
  assertEquals(models, ['aro-code', 'aro-1.5']);
  assertEquals(result.endpoint.model, 'aro-1.5');
  assert(frames.some((f) => f.includes('def add(a, b)')));
  assert(!frames.some((f) => f.includes('worker failed')));
});

Deno.test('chat: an error after text has streamed is not retried (no two answers glued together)', async () => {
  const fetchImpl = (async () => sse([{ choices: [{ delta: { content: 'Partial' } }] }, { error: { message: 'boom' } }])) as typeof fetch;
  await assertRejects(
    () => streamWithFallback(aroEndpoints('text', 'aro-code', env), [{ role: 'user', content: 'x' }], false, fetchImpl, () => {}),
    ProviderError,
    'boom',
  );
});

Deno.test('agent: an ARO job that fails with a 200 error body is retryable, never an empty answer', async () => {
  const [code] = aroEndpoints('text', 'aro-code', env);
  const fetchImpl = (async () => Response.json({ error: 'the worker failed this request' })) as typeof fetch;
  const err = await assertRejects(() => chatWithTools(code, 'sys', [{ role: 'user', text: 'hi' }], [], { fetchImpl }), ProviderError);
  assertEquals((err as ProviderError).retryable, true);
});
