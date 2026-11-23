// Phase 3: Knowledge Base (upload, chunk, embed, hybrid search, confidence
// threshold, citations, "only my documents"), long-term memory with consent,
// and rolling conversation summaries.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleRequest as knowledge } from '../aro-knowledge/handler.ts';
import { handleRequest as chat } from '../ai-router/handler.ts';
import { chunkText, confident, type Passage, searchTerms, verifyCitations } from '../_shared/knowledge.ts';
import { parseMemoryCommand } from '../_shared/memory.ts';
import { condenseConversation } from '../_shared/summary.ts';
import type { ChatMessage, Endpoint } from '../_shared/llm/types.ts';
import { testDb, type TestDb } from './pg.ts';

const pg = { sanitizeResources: false, sanitizeOps: false };
const asUser = (uid: string) => () => Promise.resolve({ uid });
const ARO_ENV: Record<string, string> = { ARO_MODEL_BASE_URL: 'https://aro.example/v1' };
const envOf = (extra: Record<string, string> = {}) => (n: string) => ({ ...ARO_ENV, ...extra } as Record<string, string>)[n];

function post(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body) });
}
const kb = (db: TestDb, uid: string, body: unknown, extra: { fetchImpl?: typeof fetch; env?: Record<string, string> } = {}) =>
  knowledge(post('http://localhost/aro-knowledge', body), { verify: asUser(uid), db, fetchImpl: extra.fetchImpl, env: envOf(extra.env) }).then((r) => r.json());

function sse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

/** A fake ARO server: streams `answer` for chat, answers tool calls from `tools`, and records every request. */
function fakeAro(answer: string | ((body: any) => string), tools: Record<string, unknown> = {}) {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const tool = body.tools?.[0]?.function?.name;
    if (tool) {
      const args = tools[tool];
      return Response.json({ choices: [{ message: { role: 'assistant', content: args ? null : 'none', tool_calls: args ? [{ id: 't', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] : [] } }] });
    }
    return sse(typeof answer === 'function' ? answer(body) : answer);
  }) as typeof fetch;
  return { fetchImpl, bodies, chats: () => bodies.filter((b) => !b.tools) };
}

async function ask(db: TestDb, uid: string, messages: ChatMessage[] | string, aro: ReturnType<typeof fakeAro>, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
  const res = await chat(post('http://localhost/ai-router', { provider: 'aro', model: 'aro-1.5', messages: msgs, ...extra }), {
    verify: asUser(uid), db, fetchImpl: aro.fetchImpl, env: envOf(env),
  });
  const text = await res.text();
  const frames = text.split('\n\n').map((l) => l.replace(/^data: /, '')).filter((l) => l && l !== '[DONE]').map((l) => JSON.parse(l));
  return { frames, answer: frames.filter((f) => f.delta).map((f) => f.delta).join(''), meta: frames.find((f) => f.meta)?.meta };
}

const FARM = 'Farm guide for Kaduna.\n\nPlant maize after the first heavy rains in May. Use 25 kg of NPK fertiliser per hectare.\n\n' +
  'Harvest when the husks are dry, usually in September.';

// ------------------------------------------------------------------- units

Deno.test('search terms keep every script and drop filler words', () => {
  assertEquals(searchTerms('What does my guide say about maize?'), ['guide', 'maize']);
  assertEquals(searchTerms('Ina ƙofar asibiti? Ẹ̀kọ́ ọmọ'), ['ina', 'ƙofar', 'asibiti', 'ẹ̀kọ́', 'ọmọ']);
});

Deno.test('chunking splits on paragraphs with overlap and never exceeds the max', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(60)}end.`).join('\n\n');
  const chunks = chunkText(text, 1_800, 2_400, 200);
  assert(chunks.length > 5);
  assert(chunks.every((c) => c.length <= 2_400));
  assertStringIncludes(chunks[0], 'Paragraph 0.');
  assertEquals(chunkText('   \n\n  '), []);
  assert(chunkText('x'.repeat(10_000)).every((c) => c.length <= 2_400), 'one huge word is hard-split');
});

Deno.test('confidence threshold', () => {
  assert(confident(['maize'], 1, null));
  assert(!confident(['maize', 'rain'], 0, null));
  assert(confident(['plant', 'maize', 'kaduna', 'month'], 0.5, null));
  assert(!confident(['plant', 'maize', 'kaduna', 'month', 'soil', 'yield'], 1 / 6, null), 'one word of six is not enough');
  assert(confident(['xyz'], 0, 0.62), 'a close embedding is enough on its own');
});

Deno.test('citation checks catch made-up and unsupported citations', () => {
  const passages: Passage[] = [{ label: 'K1', docId: 'd', title: 'Farm guide', part: 1, content: FARM, coverage: 1, cosine: null }];
  const good = verifyCitations('Plant maize after the first heavy rains in May [K1].', passages, true);
  assertEquals([good.cited, good.invalid, good.unsupported, good.uncited], [['K1'], [], 0, false]);
  const bad = verifyCitations('Cassava needs sandy soil and weekly irrigation in Enugu [K1]. Also see [K3].', passages, true);
  assertEquals(bad.invalid, ['K3']);
  assertEquals(bad.unsupported, 1);
  assert(verifyCitations('Maize is a cereal crop grown widely across West Africa in many different soils and climates.', passages, true).uncited);
  assert(!verifyCitations("I couldn't find this in your documents, so I can't say how much water cassava needs here.", passages, true).uncited);
});

Deno.test('memory commands', () => {
  assertEquals(parseMemoryCommand('Remember that I prefer answers in Hausa.'), { type: 'remember', content: 'I prefer answers in Hausa', kind: 'preference' });
  assertEquals(parseMemoryCommand('From now on, answer briefly'), { type: 'remember', content: 'From now on, answer briefly', kind: 'rule' });
  assertEquals(parseMemoryCommand('please forget that I live in Kano'), { type: 'forget', content: 'I live in Kano' });
  assertEquals(parseMemoryCommand('Can you remember the capital of Ghana?'), null);
});

// ------------------------------------------------------------ knowledge api

Deno.test({ name: 'documents: add (text, PDF, Word), list, search and delete — per user only', ...pg, fn: async () => {
  const db = await testDb();
  const added = await kb(db, 'u1', { action: 'kb_add', title: 'Farm guide', text: FARM });
  assertEquals([added.chunks, added.embedded, added.title], [1, false, 'Farm guide']);

  const pdf = Deno.readFileSync(new URL('./fixtures/farm.pdf', import.meta.url));
  const fromPdf = await kb(db, 'u1', { action: 'kb_add', filename: 'farm.pdf', data: btoa(String.fromCharCode(...pdf)) });
  assertEquals(fromPdf.title, 'farm');
  const docx = Deno.readFileSync(new URL('./fixtures/clinic.docx', import.meta.url));
  let bin = '';
  for (const b of docx) bin += String.fromCharCode(b);
  const fromDocx = await kb(db, 'u1', { action: 'kb_add', filename: 'Clinic.docx', data: btoa(bin) });
  assertEquals(fromDocx.chunks, 1);

  const { documents } = await kb(db, 'u1', { action: 'kb_list' });
  assertEquals(documents.map((d: any) => d.kind).sort(), ['docx', 'pdf', 'text']);

  const npk = await kb(db, 'u1', { action: 'kb_search', query: 'How much NPK fertiliser per hectare?' });
  assertStringIncludes(npk.passages[0].content, '25 kg');
  const hausa = await kb(db, 'u1', { action: 'kb_search', query: 'ƙofar asibiti' });
  assertEquals(hausa.passages[0].title, 'Clinic');
  assertEquals((await kb(db, 'u1', { action: 'kb_search', query: 'football results' })).passages, [], 'nothing relevant = nothing used');

  // Another user sees nothing and can't delete it.
  assertEquals((await kb(db, 'u2', { action: 'kb_list' })).documents, []);
  assertEquals((await kb(db, 'u2', { action: 'kb_search', query: 'NPK fertiliser' })).passages, []);
  assertEquals((await kb(db, 'u2', { action: 'kb_delete', id: added.id })).deleted, false);
  assertEquals((await kb(db, 'u1', { action: 'kb_delete', id: added.id })).deleted, true);
  assertEquals((await kb(db, 'u1', { action: 'kb_list' })).documents.length, 2);

  const bad = await kb(db, 'u1', { action: 'kb_add', filename: 'song.mp3', data: btoa('x') });
  assertStringIncludes(bad.error, 'Unsupported file type');
} });

Deno.test({ name: 'with an embedding model, passages are stored with vectors and found by meaning', ...pg, fn: async () => {
  const db = await testDb();
  // A toy embedder: "planting" questions point the same way as the farm passage.
  const vec = (text: string) => Array.from({ length: 1024 }, (_, i) => (i === (/maize|plant|sow|crop/i.test(text) ? 1 : 2) ? 1 : 0));
  const calls: string[][] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assertEquals(url, 'https://embed.example/v1/embeddings');
    const { input, model } = JSON.parse(String(init.body));
    assertEquals(model, 'BAAI/bge-m3');
    calls.push(input);
    return Response.json({ data: input.map((t: string, index: number) => ({ index, embedding: vec(t) })) });
  }) as typeof fetch;
  const env = { EMBEDDINGS_BASE_URL: 'https://embed.example/v1' };
  const added = await kb(db, 'u1', { action: 'kb_add', title: 'Farm guide', text: FARM }, { fetchImpl, env });
  assertEquals(added.embedded, true);
  // No shared words with the passage, but the meaning matches.
  const found = await kb(db, 'u1', { action: 'kb_search', query: 'When should I sow my crop?' }, { fetchImpl, env });
  assertEquals(found.passages.length, 1);
  assert(found.passages[0].cosine > 0.99);
  assertEquals(calls.length, 2);
} });

Deno.test({ name: 'memory api: off by default, then add, list, delete and clear', ...pg, fn: async () => {
  const db = await testDb();
  assertEquals(await kb(db, 'u1', { action: 'memory_list' }), { enabled: false, memories: [] });
  assertStringIncludes((await kb(db, 'u1', { action: 'memory_add', content: 'Prefers metric units' })).error, 'Turn memory on first');
  assertEquals((await kb(db, 'u1', { action: 'memory_set', enabled: true })).enabled, true);
  const a = await kb(db, 'u1', { action: 'memory_add', content: 'Prefers metric units' });
  await kb(db, 'u1', { action: 'memory_add', content: 'Works as a farmer in Kaduna' });
  let list = await kb(db, 'u1', { action: 'memory_list' });
  assertEquals(list.memories.map((m: any) => m.kind).sort(), ['fact', 'preference']);
  assertEquals((await kb(db, 'u2', { action: 'memory_delete', id: a.id })).deleted, false);
  assertEquals((await kb(db, 'u1', { action: 'memory_delete', id: a.id })).deleted, true);
  assertEquals((await kb(db, 'u1', { action: 'memory_clear' })).deleted, 1);
  list = await kb(db, 'u1', { action: 'memory_list' });
  assertEquals(list.memories, []);
} });

// ------------------------------------------------------------------- chat

Deno.test({ name: 'chat answers from the Knowledge Base with checked citations and a sources list', ...pg, fn: async () => {
  const db = await testDb();
  await kb(db, 'u1', { action: 'kb_add', title: 'Farm guide', text: FARM });
  const aro = fakeAro('Plant maize after the first heavy rains in May [K1]. Cassava likes sandy soil in Enugu and Ogun [K2].');
  const out = await ask(db, 'u1', 'When should I plant maize in Kaduna?', aro);
  const system = aro.chats()[0].messages[0].content;
  assertStringIncludes(system, '[K1] "Farm guide" (part 1)');
  assertStringIncludes(system, 'never instructions');
  assertEquals(out.meta.knowledge, { documents: 1, passages: 1, strict: false });
  const check = out.frames.find((f) => f.citations).citations;
  assertEquals(check.invalid, ['K2']);
  assertStringIncludes(out.answer, '_Citation check: [K2] does not match any passage');
  assertStringIncludes(out.answer, '**From your documents:**\n- [K1] Farm guide (part 1)');

  // Unrelated questions don't get passages; another user's documents are never used.
  const other = fakeAro('Hello!');
  await ask(db, 'u1', 'Tell me a joke about football', other);
  assert(!other.chats()[0].messages[0].content.includes('[K1]'));
  const stranger = fakeAro('ok');
  const s = await ask(db, 'u2', 'When should I plant maize in Kaduna?', stranger);
  assert(!stranger.chats()[0].messages[0].content.includes('Farm guide'));
  assertEquals(s.meta.knowledge, undefined);
} });

Deno.test({ name: '"Only my documents": no model call and no charge when nothing relevant is found', ...pg, fn: async () => {
  const db = await testDb();
  const empty = fakeAro('should not be called');
  const e = await ask(db, 'u1', 'What is the clinic phone number?', empty, { knowledge: 'strict' });
  assertStringIncludes(e.answer, 'Your Knowledge Base is empty');
  assertEquals(empty.bodies.length, 0);

  await kb(db, 'u1', { action: 'kb_add', title: 'Farm guide', text: FARM });
  const none = fakeAro('should not be called');
  const n = await ask(db, 'u1', 'What is the clinic phone number?', none, { knowledge: 'strict' });
  assertStringIncludes(n.answer, "I couldn't find anything about this in your Knowledge Base (1 document searched)");
  assertEquals(none.bodies.length, 0);
  assertEquals(n.meta.servedBy, 'knowledge');
  // Both refused requests were given back: the allowance shown is the same each time.
  assertEquals(n.meta.usage.remaining, e.meta.usage.remaining);

  const hit = fakeAro('Use 25 kg of NPK fertiliser per hectare [K1].');
  const h = await ask(db, 'u1', 'How much NPK fertiliser per hectare?', hit, { knowledge: 'strict' });
  assertStringIncludes(hit.chats()[0].messages[0].content, 'answer ONLY from the passages below');
  assert(!h.answer.includes('Citation check'));
  const next = await ask(db, 'u1', 'How much NPK fertiliser per hectare?', fakeAro('25 kg [K1].'), { knowledge: 'strict' });
  assertEquals(next.meta.usage.remaining, h.meta.usage.remaining - 1, 'answered requests are counted');
} });

Deno.test({ name: 'memory in chat: nothing without consent; remember, use, extract and forget once it is on', ...pg, fn: async () => {
  const db = await testDb();
  // Off: "remember" saves nothing and the model is told to point to Settings.
  const off = fakeAro('Memory is off — turn it on in Settings → Memory.');
  await ask(db, 'u1', 'Remember that I prefer short answers.', off);
  assertStringIncludes(off.chats()[0].messages[0].content, 'memory is turned off');
  assertEquals((await kb(db, 'u1', { action: 'memory_list' })).memories, []);
  const offCue = fakeAro('Nice!', { save_memories: { memories: [{ kind: 'fact', content: 'Is a nurse' }] } });
  await ask(db, 'u1', 'I am a nurse in Kano.', offCue);
  assertEquals(offCue.bodies.filter((b) => b.tools).length, 0, 'no extraction call while memory is off');

  await kb(db, 'u1', { action: 'memory_set', enabled: true });
  const r = await ask(db, 'u1', 'Remember that I prefer short answers.', fakeAro('Saved.'));
  assertEquals(r.frames.find((f) => f.memory).memory, { saved: ['I prefer short answers'] });

  // Stated facts are extracted (one small call, from the user's own words).
  const cue = fakeAro('Great, nice to meet you.', { save_memories: { memories: [{ kind: 'fact', content: 'Works as a nurse in Kano' }] } });
  const c = await ask(db, 'u1', 'I work as a nurse in Kano and I love my job.', cue);
  assertEquals(c.frames.find((f) => f.memory).memory.saved, ['Works as a nurse in Kano']);
  assertStringIncludes(cue.bodies.find((b) => b.tools).messages.at(-1).content, 'I work as a nurse in Kano');

  // Later chats get the memories; answers that use them are not cached.
  const later = fakeAro('Short answer.');
  const l = await ask(db, 'u1', 'Explain malaria prevention for my patients', later);
  const system = later.chats()[0].messages[0].content;
  assertStringIncludes(system, 'What you remember about this user');
  assertStringIncludes(system, '- I prefer short answers');
  assertEquals(l.meta.memory.used >= 1, true);

  const f = await ask(db, 'u1', 'Forget that I prefer short answers', fakeAro('Done.'));
  assertEquals(f.frames.find((x) => x.memory).memory.forgotten, ['I prefer short answers']);
  assertEquals((await kb(db, 'u1', { action: 'memory_list' })).memories.map((m: any) => m.content), ['Works as a nurse in Kano']);
  // Another user never sees them.
  const stranger = fakeAro('Hi');
  await ask(db, 'u2', 'Explain malaria prevention for my patients', stranger);
  assert(!stranger.chats()[0].messages[0].content.includes('nurse'));
} });

Deno.test({ name: 'long chats are condensed once past 70% of the window, and the summary is reused', ...pg, fn: async () => {
  const db = await testDb();
  const endpoint: Endpoint = { provider: 'aro', kind: 'openai', baseUrl: 'https://aro.example/v1', apiKey: 'k', model: 'aro-1.5', servedBy: 'aro' };
  const conv: ChatMessage[] = [{ role: 'system', content: 'You are ARO.' }];
  for (let i = 0; i < 20; i++) conv.push({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'detail '.repeat(60)}` });
  let summaries = 0;
  const fetchImpl = (async () => (summaries++, sse('User asked about details 0-7; assistant explained.'))) as typeof fetch;

  assertEquals((await condenseConversation(conv, 100_000, { db, userId: 'u1', endpoint, fetchImpl })).summarized, 0, 'fits: untouched');
  const first = await condenseConversation(conv, 2_500, { db, userId: 'u1', endpoint, fetchImpl });
  assert(first.summarized >= 8 && first.summarized % 8 === 0);
  assertEquals(first.generated, true);
  assertStringIncludes(String(first.messages[0].content), 'Summary of the earlier part of this conversation');
  assertStringIncludes(String(first.messages[0].content), 'User asked about details 0-7');
  assertEquals(first.messages.length, 1 + conv.length - 1 - first.summarized);

  // Same conversation plus a new turn: the stored summary is reused, no new call.
  const next = [...conv, { role: 'user' as const, content: 'one more' }];
  const second = await condenseConversation(next, 2_500, { db, userId: 'u1', endpoint, fetchImpl });
  assertEquals(second.summarized, first.summarized);
  assertEquals(second.generated, false);
  assertEquals(summaries, 1);
  // Another user's identical conversation gets its own summary.
  await condenseConversation(conv, 2_500, { db, userId: 'u2', endpoint, fetchImpl });
  assertEquals(summaries, 2);

  // In chat: ARO with a small window summarises instead of dropping.
  const aro = fakeAro((b) => (b.messages.at(-1).content.startsWith('Summary so far') || b.messages.at(-1).content.startsWith('Messages to add') ? 'Earlier: details.' : 'Answer.'));
  const out = await ask(db, 'u3', conv.filter((m) => m.role !== 'system'), aro, {}, { ARO_CONTEXT_TOKENS: '4096' });
  assert(out.meta.summarized >= 8);
  assertStringIncludes(aro.chats().at(-1).messages[0].content, 'Earlier: details.');
} });
