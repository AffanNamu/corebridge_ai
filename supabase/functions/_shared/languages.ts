// Verified facts about Nigerian languages, added to ARO's instructions when a
// conversation involves one of them, plus strict rules against inventing
// words. ARO 1.5's foundation model knows little about these languages and
// was seen confidently inventing greetings ("Aba!"), words ("Kamalama") and
// classifications ("Hausa is Niger-Congo"). Grounding + rules fix the common
// questions now; training (training/seed/language_facts.jsonl) and the test
// sets (training/eval/*.jsonl) keep it from regressing.
//
// Only well-established facts belong here: language classification follows
// standard references (Glottolog, Ethnologue); vocabulary is everyday,
// standard usage. Anything that varies by dialect says so. Do not add
// entries you cannot verify — a wrong "verified" fact is worse than none.

import { type ChatMessage, textOf } from './llm/types.ts';

export type LanguageCode = 'ha' | 'yo' | 'ig' | 'ff' | 'pcm';

export const LANGUAGE_FACTS: Record<LanguageCode, string> = {
  ha: `HAUSA
- Family: Afroasiatic. Branch: Chadic (West Chadic). Hausa is NOT a Niger-Congo language, and Chadic is a branch, not a family. Hausa is the most widely spoken Chadic language.
- Where: mainly northern Nigeria and southern Niger; a major lingua franca across West Africa.
- Writing: Latin script ("Boko") with the extra letters ɓ, ɗ, ƙ and ƴ (often written 'y); also Arabic-based Ajami. Hausa spelling does not use ɛ or ɔ.
- Tone (high, low, falling) and vowel length matter but are usually not marked in everyday writing.
- Gender matters in "you": kai = you (to a man), ke = you (to a woman), ku = you (plural). The difference is gender and number only, not formality. Same with "your": -nka (man), -nki (woman), -nku (plural).
- Standard Hausa is based on the Kano dialect; other dialects (e.g. Sokoto, Katsina, Zaria) differ in some words and pronunciation.
- Greetings and phrases:
  • Sannu = hello (also said in sympathy, e.g. to someone working or hurt). A common reply: Yauwa, sannu.
  • Ina kwana? = morning greeting, literally "how did you pass the night?". Reply: Lafiya lau = "fine, well".
  • Ina wuni? = daytime greeting, "how has the day been?". Reply: Lafiya lau.
  • Barka da safiya = good morning; Barka da rana = good afternoon; Barka da yamma = good evening.
  • Ina gida? = "how is the household/family?". Reply: Lafiya lau.
  • Yaya aiki? = "how is work?". Reply: Da godiya ("with thanks", i.e. fine).
  • Na gode = thank you; Na gode sosai = thank you very much.
  • Barka da zuwa = welcome; Sai anjima = see you later; Sai gobe = see you tomorrow.`,
  yo: `YORUBA
- Family: Niger-Congo → Volta-Niger → Yoruboid.
- Where: south-western Nigeria, and Benin and Togo.
- Writing: Latin script with the letters ẹ, ọ, ṣ and tone marks (acute = high, grave = low, unmarked = mid). Three level tones; tone changes meaning.
- Respect forms: "ẹ" (plural/respectful) vs "o" (familiar) in many greetings.
- Greetings and phrases:
  • Ẹ kú àárọ̀ / Ẹ káàárọ̀ = good morning (respectful); Káàárọ̀ = good morning (to a peer).
  • Ẹ kú ọ̀sán = good afternoon; Ẹ kú ìrọ̀lẹ́ = good evening.
  • Báwo ni? = how are you?
  • Ẹ ṣé / Ẹ ṣeun = thank you (respectful); O ṣé = thank you (to a peer).
  • Ẹ kú iṣẹ́ = greeting to someone at work ("well done").`,
  ig: `IGBO
- Family: Niger-Congo → Volta-Niger → Igboid.
- Where: south-eastern Nigeria.
- Writing: Latin script with the letters ị, ọ, ụ, ṅ and digraphs such as ch, gb, gh, gw, kp, kw, nw, ny, sh. Tonal (high and low, with downstep); tone marks are often omitted.
- Standard Igbo coexists with many dialects that differ noticeably.
- Greetings and phrases:
  • Ndewo = hello.
  • Kedu? = how are you? Reply: Ọ dị mma = it is fine.
  • Ụtụtụ ọma = good morning; Ị bọọla chi? = "did you wake well?" (morning greeting).
  • Daalụ = thank you.
  • Ka ọ dị = goodbye / see you.`,
  ff: `FULFULDE (Fula, Fulani; Pulaar/Pular in the west)
- Family: Niger-Congo → Atlantic branch. Not related to Hausa.
- Where: across the Sahel from Senegal to Cameroon and Sudan; in Nigeria mainly in the north and north-east (e.g. Adamawa Fulfulde).
- Grammar: many noun classes and consonant changes at the start of words.
- Writing: Latin script with ɓ, ɗ, ŋ, ƴ; also Ajami.
- Greetings vary a lot by dialect. Widely used in Nigeria/Cameroon varieties:
  • Jam waali? = morning greeting, "did you spend the night in peace?". Reply: Jam tan = "peace only".
  • A jaraama = thank you.
  Say that the exact form depends on the dialect when asked for other phrases.`,
  pcm: `NIGERIAN PIDGIN (Naijá)
- An English-lexified creole with its own grammar — a language, not "broken English". Widely spoken across Nigeria.
- Phrases: How far? = hi / how are things?; I dey = I'm fine / I'm here; Wetin dey happen? = what's happening?; Abeg = please.`,
};

export const LANGUAGE_RULES = 'Language accuracy rules (follow strictly): ' +
  'Use the verified reference below for these languages and prefer it over your own memory. ' +
  'Never invent words, translations, greetings, proverbs or etymologies. ' +
  'If a word or sentence is not covered by the reference and you are not certain of it, say plainly that you are not sure, ' +
  'give your best attempt clearly labelled as unverified (or no attempt), and suggest checking with a native speaker or a dictionary. ' +
  'Say when usage depends on dialect, region, gender or politeness. ' +
  'For technical or modern terms with no established word, say so and give the borrowed form people commonly use instead of coining one. ' +
  'Your ability to write full sentences in Hausa, Yoruba, Igbo and Fulfulde is limited: for a full-sentence translation into them, ' +
  'warn that it may contain errors and keep it short, or say you cannot translate it reliably. Never pad an answer with repeated or filler words.';

const NAMES: Record<LanguageCode, RegExp> = {
  ha: /\bhausa\b|\bharshen? hausa\b/i,
  yo: /\byoruba\b|\byorùbá\b|\bede yoruba\b/i,
  ig: /\bigbo\b|\bibo\b|\basụsụ igbo\b/i,
  ff: /\bfulfulde\b|\bfula\b|\bfulani\b|\bfulbe\b|\bpulaar\b|\bpular\b|\bpeul\b/i,
  pcm: /\bpidgin\b|\bnaij[aá]\b/i,
};

// Words that show the user is writing in the language (common greetings, special letters).
const WORDS: Record<LanguageCode, RegExp> = {
  ha: /\b(sannu|ina kwana|ina wuni|na gode|barka da|lafiya lau|yaya|kai|ke)\b|[ɓɗƙƴ]/i,
  yo: /\b(bawo ni|báwo|ẹ kú|e ku aaro|ẹ ṣé|e se|ẹ ṣeun|o ṣe)\b|[ẹọṣ]/i,
  ig: /\b(kedu|ndewo|daalụ|daalu|ụtụtụ)\b|[ịụṅ]/i,
  ff: /\b(jam waali|a jaraama|jam tan|no mbaɗɗaa)\b/i,
  pcm: /\b(how far|wetin|abeg|i dey|una)\b/i,
};

/** Nigerian languages a conversation involves (by name, or by words written in them). */
export function languagesIn(messages: ChatMessage[], recent = 4): LanguageCode[] {
  const text = messages.filter((m) => m.role !== 'system').slice(-recent).map((m) => textOf(m.content)).join('\n');
  const found = new Set<LanguageCode>();
  for (const code of Object.keys(NAMES) as LanguageCode[]) {
    if (NAMES[code].test(text)) found.add(code);
  }
  // Writing in the language counts only for the last user message (short words like "kai" are common elsewhere).
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const last = lastUser ? textOf(lastUser.content) : '';
  for (const code of Object.keys(WORDS) as LanguageCode[]) {
    const hits = last.match(new RegExp(WORDS[code].source, 'gi')) ?? [];
    if (hits.length >= 2 || (hits.length === 1 && /[ɓɗƙƴẹọṣịụṅ]/.test(hits[0]))) found.add(code);
  }
  return [...found];
}

/** The rules plus the verified facts for these languages, to append to the system prompt. */
export function languageGrounding(codes: LanguageCode[]): string {
  if (!codes.length) return '';
  return `${LANGUAGE_RULES}\n\nVerified reference:\n${codes.map((c) => LANGUAGE_FACTS[c]).join('\n\n')}`;
}

// ----------------------------------------------- sentence translation limit

const LANGUAGE_NAMES: Record<LanguageCode, string> = { ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo', ff: 'Fulfulde', pcm: 'Nigerian Pidgin' };
const TARGET = /\b(?:translate|translation|say|write|put|turn|convert)\b[\s\S]{0,200}?\b(?:into|in|to)\s+(hausa|yoruba|igbo|ibo|fulfulde|fula|fulani|pulaar)\b/i;
const TARGET_CODE: Record<string, LanguageCode> = { hausa: 'ha', yoruba: 'yo', igbo: 'ig', ibo: 'ig', fulfulde: 'ff', fula: 'ff', fulani: 'ff', pulaar: 'ff' };

/**
 * Languages ARO 1.5 cannot yet translate full sentences into (it produced
 * invented text in tests). Configurable with ARO_SENTENCE_TRANSLATION_LIMITED
 * (comma-separated codes; empty once a trained adapter passes the test sets).
 */
export function limitedLanguages(env: (name: string) => string | undefined): Set<LanguageCode> {
  const raw = env('ARO_SENTENCE_TRANSLATION_LIMITED');
  const codes = (raw === undefined ? 'ha,yo,ig,ff' : raw).split(',').map((c) => c.trim()).filter(Boolean);
  return new Set(codes as LanguageCode[]);
}

/** The target language when the user asks for a full sentence (not a short phrase) to be translated into it. */
export function sentenceTranslationInto(text: string): LanguageCode | null {
  const m = text.match(TARGET);
  if (!m) return null;
  const code = TARGET_CODE[m[1].toLowerCase()];
  const quoted = text.match(/["“'‘]([^"”'’]{3,})["”'’]/);
  const payload = quoted ? quoted[1] : text.replace(m[0], ' ');
  const words = payload.trim().split(/\s+/).filter(Boolean).length;
  return words >= 5 ? code : null;
}

export function sentenceTranslationDirective(code: LanguageCode): string {
  const lang = LANGUAGE_NAMES[code];
  return `This request asks for a full-sentence translation into ${lang}. ARO 1.5 cannot do that reliably yet and has produced ` +
    `made-up ${lang} in tests, so do NOT write any translation into ${lang}. Instead: say plainly that you can't translate full ` +
    `sentences into ${lang} reliably yet; offer any verified phrases from the reference that fit the request; and suggest ` +
    `checking with a native speaker, turning on Web to look for an existing translation, or choosing another model. Keep it short.`;
}
