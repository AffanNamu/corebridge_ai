// Rolling summaries: when a conversation passes 70% of the model's input
// budget, the oldest messages are condensed into a summary instead of being
// dropped. Summaries are made in blocks of 8 messages and stored by a hash of
// the conversation prefix they cover, so each block is summarised once and the
// next summary builds on the previous one (aro_conversation_summaries).

import { estimateTokens } from './cost.ts';
import type { Db } from './db.ts';
import { streamChat } from './llm/chat_stream.ts';
import type { ChatMessage, Endpoint } from './llm/types.ts';
import { textOf } from './llm/types.ts';

export const SUMMARY_TRIGGER = 0.7;
const BLOCK = 8;
const KEEP_RECENT = 4;
const SUMMARY_TOKENS = 700;
const MESSAGE_CHARS = 2_000;

export interface CondenseDeps {
  db: Db | null;
  userId: string;
  endpoint: Endpoint;
  fetchImpl?: typeof fetch;
}

export interface Condensed {
  messages: ChatMessage[];
  /** Messages replaced by the summary (0 = unchanged). */
  summarized: number;
  /** A new summary call was made (vs. a stored one reused). */
  generated: boolean;
}

function tokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function flatten(m: ChatMessage): string {
  return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');
}

async function prefixHash(conv: ChatMessage[], n: number): Promise<string> {
  return await sha256(JSON.stringify(conv.slice(0, n).map((m) => [m.role, flatten(m)])));
}

async function completeText(endpoint: Endpoint, messages: ChatMessage[], fetchImpl?: typeof fetch): Promise<string> {
  let text = '';
  for await (const event of streamChat(endpoint, messages, { thinking: false, fetchImpl, maxTokens: 600 })) {
    if (event.type === 'content') text += event.text;
  }
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Summarises the oldest messages when the conversation is past 70% of `maxInputTokens`. Never throws. */
export async function condenseConversation(messages: ChatMessage[], maxInputTokens: number, deps: CondenseDeps): Promise<Condensed> {
  const unchanged = { messages, summarized: 0, generated: false };
  const system = messages.filter((m) => m.role === 'system');
  const conv = messages.filter((m) => m.role !== 'system');
  const limit = Math.floor(maxInputTokens * SUMMARY_TRIGGER);
  if (tokens(messages) <= limit || conv.length < BLOCK + KEEP_RECENT) return unchanged;

  // Fewest whole blocks to summarise so the rest (plus the summary) fits under the trigger.
  const room = limit - tokens(system) - SUMMARY_TOKENS;
  let k = BLOCK;
  const maxK = Math.floor((conv.length - KEEP_RECENT) / BLOCK) * BLOCK;
  while (k < maxK && tokens(conv.slice(k)) > room) k += BLOCK;
  if (k > maxK) return unchanged;

  try {
    const hashes: string[] = [];
    for (let n = BLOCK; n <= k; n += BLOCK) hashes.push(await prefixHash(conv, n));
    const found = deps.db
      ? await deps.db.rpc<{ hash: string; covered: number; summary: string } | null>('aro_summary_lookup', { p_user: deps.userId, p_hashes: hashes })
      : null;
    let summary = found?.summary ?? '';
    let covered = found?.covered ?? 0;
    let generated = false;
    if (covered < k) {
      const lines = conv.slice(covered, k).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${textOf(m.content).slice(0, MESSAGE_CHARS)}`);
      summary = await completeText(deps.endpoint, [
        {
          role: 'system',
          content: 'You condense the earlier part of a conversation so it can continue without it. Keep: the user\'s goals, ' +
            'decisions, facts and numbers they gave, names, open questions, and what the assistant already answered. ' +
            'Write in the conversation\'s language, at most 250 words, as plain notes. Do not add anything new.',
        },
        { role: 'user', content: `${summary ? `Summary so far:\n${summary}\n\n` : ''}Messages to add:\n${lines.join('\n\n')}` },
      ], deps.fetchImpl);
      if (!summary) return unchanged;
      covered = k;
      generated = true;
      await deps.db?.rpc('aro_summary_save', { p_user: deps.userId, p_hash: hashes.at(-1)!, p_covered: k, p_summary: summary })
        .catch((e) => console.warn('summary save failed', e));
    }
    const note = `Summary of the earlier part of this conversation (${covered} older messages were condensed to fit):\n${summary}`;
    const sysIndex = system.findIndex((m) => typeof m.content === 'string');
    const newSystem: ChatMessage[] = sysIndex >= 0
      ? system.map((m, i) => (i === sysIndex ? { ...m, content: `${m.content}\n\n${note}` } : m))
      : [{ role: 'system', content: note }];
    return { messages: [...newSystem, ...conv.slice(covered)], summarized: covered, generated };
  } catch (err) {
    console.warn('conversation summary failed:', err instanceof Error ? err.message : err);
    return unchanged;
  }
}
