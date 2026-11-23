// Long-term memory for chat. OFF by default: nothing is stored until the user
// turns it on (Settings → Memory), and they can see and delete every entry.
//
//   * "Remember that …" / "From now on …" saves directly; "Forget …" deletes.
//   * When the user states something durable about themselves ("I prefer…",
//     "my name is…"), one small extraction call proposes at most 3 entries.
//     Only the user's own words are used — never documents, web pages or the
//     model's answer — and sensitive categories are excluded.
//   * Each turn, the newest rules/preferences and the entries matching the
//     message are added to the system prompt.

import { chatWithTools, type ToolDefinition } from './llm/tool_chat.ts';
import type { Endpoint } from './llm/types.ts';
import { type JsonSchema, validate } from './schema.ts';

export type MemoryKind = 'preference' | 'fact' | 'rule';

export type MemoryCommand = { type: 'remember'; content: string; kind: MemoryKind } | { type: 'forget'; content: string };

export function kindOf(text: string): MemoryKind {
  if (/\b(always|never|from now on|don'?t|do not|every time|whenever)\b/i.test(text)) return 'rule';
  if (/\b(prefer(?:s|red)?|likes?|loves?|hates?|dislikes?|favou?rite|rather)\b/i.test(text)) return 'preference';
  return 'fact';
}

/** An explicit "remember …" or "forget …" instruction, or null. */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const t = text.trim();
  if (t.length > 400 || t.includes('\n')) return null;
  let m = t.match(/^(?:please\s+)?forget\s+(?:that\s+|about\s+|what i said about\s+)?(.{3,})$/i);
  if (m) return { type: 'forget', content: m[1].replace(/[.!]+$/, '').trim() };
  m = t.match(/^(?:please\s+)?(?:remember|note|keep in mind|don'?t forget)\s*(?:that|:)?\s+(.{3,})$/i);
  if (m) {
    const content = m[1].replace(/[.!]+$/, '').trim();
    return { type: 'remember', content, kind: kindOf(content) };
  }
  m = t.match(/^from now on,?\s+(.{3,})$/i);
  if (m) return { type: 'remember', content: `From now on, ${m[1].replace(/[.!]+$/, '').trim()}`, kind: 'rule' };
  return null;
}

/** The user said something durable about themselves (worth one extraction call). */
const CUES = /\b(i (?:prefer|like|love|hate|dislike|am an?|'m an?|work|live|study|speak|use)|i'm (?:an?|from|based)|my (?:name|job|company|business|team|language|role)\b|call me|i always|i never|please always|please never)\b/i;
export function hasMemoryCue(text: string): boolean {
  return CUES.test(text) && text.length <= 4_000;
}

export function memoryBlock(memories: string[]): string {
  return [
    'What you remember about this user (they turned on memory and can see and delete these in Settings → Memory). ' +
    'Use it when relevant; do not list it back to them unless asked. Their message in this chat takes priority if it disagrees:',
    ...memories.map((m) => `- ${m}`),
  ].join('\n');
}

export const MEMORY_OFF_NOTE = 'The user asked you to remember or forget something, but memory is turned off for them, so nothing ' +
  'was saved. Tell them briefly that they can turn it on in Settings → Memory.';

const SAVE_TOOL: ToolDefinition = {
  name: 'save_memories',
  description: 'Save durable facts or preferences the user stated about themselves. Use an empty list when there is nothing worth keeping.',
  parameters: {
    type: 'object',
    properties: {
      memories: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['preference', 'fact', 'rule'] },
            content: { type: 'string', minLength: 3, maxLength: 200 },
          },
          required: ['kind', 'content'],
          additionalProperties: false,
        },
      },
    },
    required: ['memories'],
    additionalProperties: false,
  },
};

const EXTRACT_SYSTEM = [
  'You decide what a personal assistant should remember long-term about the user, from ONE message they wrote.',
  'Keep only durable things they stated about themselves or how they want to be helped: their name, role or work, ' +
  'languages, preferences for answers (length, language, tone, format), and standing rules ("always…", "never…").',
  'Do NOT keep: one-off requests, questions, anything about other people, or sensitive details (health, religion, ' +
  'politics, sexuality, ethnicity, finances, passwords, ID numbers, exact addresses or locations).',
  'Write each entry as a short third-person statement, e.g. "Prefers short answers", "Works as a nurse in Kano". ' +
  'Call save_memories; use an empty list if nothing qualifies.',
].join('\n');

/** Proposes memories from the user's message. Never throws; [] on any failure. */
export async function extractMemories(
  endpoint: Endpoint,
  userText: string,
  fetchImpl?: typeof fetch,
): Promise<{ kind: MemoryKind; content: string }[]> {
  if (endpoint.kind !== 'openai' && endpoint.kind !== 'anthropic') return [];
  try {
    const turn = await chatWithTools(endpoint, EXTRACT_SYSTEM, [{ role: 'user', text: userText.slice(0, 4_000) }], [SAVE_TOOL], {
      fetchImpl,
      maxTokens: 300,
    });
    const call = turn.toolCalls.find((c) => c.name === SAVE_TOOL.name);
    if (!call || validate(SAVE_TOOL.parameters as unknown as JsonSchema, call.args).length) return [];
    return (call.args.memories as { kind: MemoryKind; content: string }[]).map((m) => ({ kind: m.kind, content: m.content.trim() }));
  } catch (err) {
    console.warn('memory extraction failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
