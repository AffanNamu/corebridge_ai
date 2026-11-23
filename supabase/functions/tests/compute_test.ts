import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { bareExpression, computeForChat, mentionsDate, wantsArithmetic, wantsDateLogic } from '../_shared/compute.ts';
import { handleRequest } from '../ai-router/handler.ts';
import type { Endpoint } from '../_shared/llm/types.ts';
import { testDb } from './pg.ts';

const NOW = () => new Date('2026-11-23T10:00:00Z'); // a Monday
const endpoint: Endpoint = {
  provider: 'aro', kind: 'openai', baseUrl: 'https://aro.example/v1', apiKey: 'k', model: 'aro-1.5', servedBy: 'aro',
};
const user = (content: string) => ({ role: 'user' as const, content });

function toolReply(calls: { name: string; args: unknown }[], content = '') {
  return Response.json({
    choices: [{
      message: {
        role: 'assistant', content,
        tool_calls: calls.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      },
    }],
  });
}

Deno.test('detects arithmetic and date questions, not ordinary chat', () => {
  assert(wantsArithmetic('What is 15% of 2400?'));
  assert(wantsArithmetic('I bought 3 bags at ₦4,500 each, what is the total?'));
  assert(!wantsArithmetic('Tell me about Kano'));
  assert(!wantsArithmetic('Is 2026-11-23 a holiday?'), 'an ISO date is not a subtraction');
  assert(wantsDateLogic('How many days until 2026-12-25?'));
  assert(wantsDateLogic('What day of the week was 1960-10-01?'));
  assert(!wantsDateLogic('What should I cook today?'));
  assert(mentionsDate('What should I cook today?'));
  assert(!mentionsDate('Translate "good morning" to Hausa'));
});

Deno.test('bare expressions are recognised, sentences are not', () => {
  assertEquals(bareExpression('What is 15% of 2400?'), '15% of 2400');
  assertEquals(bareExpression('calculate (12.5 + 7.5) * 4'), '(12.5 + 7.5) * 4');
  assertEquals(bareExpression('2^10 ='), '2^10');
  assertEquals(bareExpression('If I save 5000 a week for 12 weeks how much will I have?'), null);
});

Deno.test('a bare expression is computed directly, with no model call', async () => {
  const fetchImpl = (() => { throw new Error('no model call expected'); }) as unknown as typeof fetch;
  const out = await computeForChat([user('What is 15% of 2400?')], [endpoint], fetchImpl, NOW);
  assertEquals(out.results, ['calculate(15% of 2400) = 360']);
  assertEquals(out.usedModel, false);
  assertStringIncludes(out.block, 'do not recompute');
});

Deno.test('ordinary chat gets nothing; "today" gets only the date, no model call', async () => {
  const fetchImpl = (() => { throw new Error('no model call expected'); }) as unknown as typeof fetch;
  assertEquals((await computeForChat([user('Tell me a story')], [endpoint], fetchImpl, NOW)).block, '');
  const today = await computeForChat([user('What should I cook today?')], [endpoint], fetchImpl, NOW);
  assertStringIncludes(today.block, 'Today is Monday, 2026-11-23');
  assertEquals(today.usedModel, false);
});

Deno.test('word problems use a tool pass; invalid calls are not run', async () => {
  const bodies: any[] = [];
  const replies = [
    toolReply([
      { name: 'calculate', args: { expression: '5000 * 12' } },
      { name: 'calculate', args: { expression: '1+1', extra: true } }, // rejected by the schema
      { name: 'date_math', args: { op: 'add', date: '2026-11-23', amount: 12, unit: 'weeks' } },
    ]),
    toolReply([], 'done'),
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return replies.shift()!;
  }) as typeof fetch;
  const out = await computeForChat(
    [user('If I save 5000 a week for 12 weeks from today, how much will I have and on what date?')],
    [endpoint], fetchImpl, NOW,
  );
  assertEquals(bodies.length, 2);
  assertEquals(out.results.length, 2);
  assertEquals(out.results[0], 'calculate(5000 * 12) = 60000');
  assertStringIncludes(out.results[1], '2027-02-15');
  const toolMsgs = bodies[1].messages.filter((m: any) => m.role === 'tool');
  assert(toolMsgs.some((m: any) => String(m.content).includes('is not an allowed field')));
});

Deno.test('a failing tool pass never breaks chat', async () => {
  const fetchImpl = (async () => new Response('down', { status: 503 })) as typeof fetch;
  const out = await computeForChat([user('How many days from 2026-11-23 to 2026-12-25?')], [endpoint], fetchImpl, NOW);
  assertEquals(out.results, []);
  assertStringIncludes(out.block, 'Today is');
});

Deno.test({
  name: 'chat gives the model the exact value before it answers',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let sent: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '360' } }] })}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const res = await handleRequest(
      new Request('http://localhost/ai-router', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ provider: 'aro', model: 'aro-1.5', messages: [user('What is 15% of 2400?')] }),
      }),
      {
        verify: () => Promise.resolve({ uid: 'user-1' }),
        fetchImpl,
        db: await testDb(),
        env: (n: string) => ({ ARO_MODEL_BASE_URL: 'https://aro.example/v1' } as Record<string, string>)[n],
      },
    );
    const text = await res.text();
    assertStringIncludes(text, 'Computed 1 exact value');
    assertStringIncludes(text, '"computed":["calculate(15% of 2400) = 360"]');
    const system = sent.messages.filter((m: any) => m.role === 'system');
    assertEquals(system.length, 1, 'one system message');
    assertStringIncludes(system[0].content, 'calculate(15% of 2400) = 360');
  },
});
