// Nigerian-language accuracy: verified facts reach the model when the
// conversation involves these languages, ARO declines full-sentence
// translation it can't do, and repetition loops are cut off.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleRequest as chat, isRepeating } from '../ai-router/handler.ts';
import { readSseData } from '../_shared/http.ts';
import { LANGUAGE_FACTS, languageGrounding, languagesIn, sentenceTranslationInto } from '../_shared/languages.ts';
import { testDb } from './pg.ts';

const pg = { sanitizeResources: false, sanitizeOps: false };
const user = (content: string) => ({ role: 'user' as const, content });

Deno.test('the verified reference has the facts ARO got wrong in the audit', () => {
  assertStringIncludes(LANGUAGE_FACTS.ha, 'Family: Afroasiatic. Branch: Chadic');
  assertStringIncludes(LANGUAGE_FACTS.ha, 'NOT a Niger-Congo');
  assertStringIncludes(LANGUAGE_FACTS.ha, 'Ina kwana?');
  assertStringIncludes(LANGUAGE_FACTS.ha, 'Lafiya lau');
  assertStringIncludes(LANGUAGE_FACTS.ha, 'Na gode = thank you');
  assertStringIncludes(LANGUAGE_FACTS.ha, 'kai = you (to a man), ke = you (to a woman)');
  assertStringIncludes(LANGUAGE_FACTS.yo, 'Niger-Congo → Volta-Niger → Yoruboid');
  assertStringIncludes(LANGUAGE_FACTS.yo, 'Ẹ ṣé');
  assertStringIncludes(LANGUAGE_FACTS.ig, 'Niger-Congo → Volta-Niger → Igboid');
  assertStringIncludes(LANGUAGE_FACTS.ig, 'Daalụ = thank you');
  assertStringIncludes(LANGUAGE_FACTS.ff, 'Niger-Congo → Atlantic');
  assertStringIncludes(LANGUAGE_FACTS.ff, 'A jaraama = thank you');
  // The invented forms from the audit must never appear as "verified".
  for (const invented of ['Kamalama', 'Aba!', 'Kordofanian', 'kɛnna', 'Aje', 'Ebe ']) {
    assert(!Object.values(LANGUAGE_FACTS).join('\n').includes(invented), invented);
  }
});

Deno.test('languages are detected by name or by writing in them', () => {
  assertEquals(languagesIn([user('Which family is Hausa in?')]), ['ha']);
  assertEquals(languagesIn([user('How do Igbo and Yoruba people say thanks?')]).sort(), ['ig', 'yo']);
  assertEquals(languagesIn([user('Fulani greetings please')]), ['ff']);
  assertEquals(languagesIn([user('Sannu! Ina kwana?')]), ['ha']);
  assertEquals(languagesIn([user('Ẹ káàárọ̀, báwo ni?')]), ['yo']);
  assertEquals(languagesIn([user('Kedu? Daalụ')]), ['ig']);
  assertEquals(languagesIn([user('Write a poem about the sea')]), []);
  assertEquals(languagesIn([user('kai, what a day')]), [], 'one common word is not enough');
  assertEquals(languageGrounding([]), '');
});

Deno.test('full-sentence translation into a limited language is detected; short phrases and other directions are not', () => {
  assertEquals(sentenceTranslationInto("Translate into Igbo: 'My grandmother sold yams at the market yesterday.'"), 'ig');
  assertEquals(sentenceTranslationInto('Please translate this into Hausa: The rains came early this year and farmers were happy.'), 'ha');
  assertEquals(sentenceTranslationInto('How do you say thank you in Hausa?'), null);
  assertEquals(sentenceTranslationInto("Translate 'good morning' into Yoruba"), null);
  assertEquals(sentenceTranslationInto('Translate this Hausa into English: Ina kwana, yaya gida, ina fatan kuna lafiya'), null);
});

function aroServer() {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

async function send(content: string, model = 'aro-1.5', server = aroServer(), env: Record<string, string> = {}) {
  const res = await chat(new Request('http://x/ai-router', {
    method: 'POST',
    body: JSON.stringify({ provider: 'aro', model, cache: false, messages: [user(content)] }),
  }), {
    verify: () => Promise.resolve({ uid: 'user-1' }), db: await testDb(), fetchImpl: server.fetchImpl,
    env: (n) => ({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', ...env } as Record<string, string>)[n],
  });
  const frames: any[] = [];
  for await (const p of readSseData(res.body!)) if (p !== '[DONE]') frames.push(JSON.parse(p));
  return { body: server.bodies[0], frames };
}

Deno.test({ name: 'ARO gets the verified reference, the no-invention rules and a repetition penalty', ...pg, fn: async () => {
  const { body, frames } = await send('Which language family does Hausa belong to, and how do you say thank you?');
  const system = body.messages[0].content;
  assertEquals(body.messages.filter((m: any) => m.role === 'system').length, 1);
  assertStringIncludes(system, 'Your model is ARO 1.5'); // the identity prompt stays first
  assertStringIncludes(system, 'Never invent words, translations');
  assertStringIncludes(system, 'Family: Afroasiatic. Branch: Chadic');
  assert(!system.includes('YORUBA'), 'only the languages in the conversation');
  assertEquals(body.repetition_penalty, 1.1);
  assertEquals(frames.find((f) => f.meta).meta.languages, ['ha']);

  const plain = await send('Explain recursion');
  assert(!plain.body.messages[0].content.includes('Verified reference'));
} });

Deno.test({ name: 'a full sentence into Igbo is declined honestly instead of invented; configurable', ...pg, fn: async () => {
  const { body } = await send("Translate into Igbo: 'My grandmother sold yams at the market yesterday.'", 'aro-translate');
  const system = body.messages[0].content;
  assertStringIncludes(system, 'do NOT write any translation into Igbo');
  assertStringIncludes(system, 'IGBO');
  const allowed = await send("Translate into Igbo: 'My grandmother sold yams at the market yesterday.'", 'aro-translate', aroServer(), { ARO_SENTENCE_TRANSLATION_LIMITED: '' });
  assert(!allowed.body.messages[0].content.includes('do NOT write'), 'empty list = translate normally');
} });

Deno.test('repetition loops are recognised', () => {
  assert(isRepeating('Nkọkọ mme na ' + 'ọkụ '.repeat(30)));
  assert(isRepeating('kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna kɛnna'));
  assert(!isRepeating('Na gode sosai. Barka da safiya, ina kwana? Lafiya lau. '.repeat(2)));
  assert(!isRepeating('1. Hausa: Na gode\n2. Yoruba: Ẹ ṣé\n3. Igbo: Daalụ\n4. Fulfulde: A jaraama'));
});

Deno.test({ name: 'a looping answer is cut off with an honest note', ...pg, fn: async () => {
  const fetchImpl = (async () => {
    const chunks = ['Nkọkọ mme ', ...Array(40).fill('ọkụ ')].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    return new Response(chunks.join('') + 'data: [DONE]\n\n');
  }) as typeof fetch;
  const { frames } = await send('Say something long', 'aro-1.5', { bodies: [], fetchImpl });
  const text = frames.filter((f) => f.delta).map((f) => f.delta).join('');
  assertStringIncludes(text, 'started repeating itself');
  assert((text.match(/ọkụ/g) ?? []).length < 25, 'stopped early');
} });
