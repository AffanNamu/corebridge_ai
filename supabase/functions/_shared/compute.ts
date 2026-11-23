// Deterministic offloading for chat: arithmetic and date questions are
// computed by exact tools (_shared/calc.ts) before the model answers, and the
// results are given to the model as verified values — it explains, it doesn't
// calculate.
//
//   1. A message that is just an expression ("what is 15% of 2400?") is
//      evaluated directly, with no extra model call.
//   2. Otherwise a short tool-calling pass (max 3 rounds) lets the model call
//      calculate / date_math for every step it needs.

import { CALC_TOOLS, calculate, formatNumber, runCalcTool } from './calc.ts';
import { type AgentMessage, chatWithTools } from './llm/tool_chat.ts';
import type { ChatMessage, Endpoint } from './llm/types.ts';
import { textOf } from './llm/types.ts';
import { type JsonSchema, validate } from './schema.ts';

const ARITHMETIC = /\d%?\s*(?:[-+*/^×÷%]|\bpercent\b|\bmod\b|\btimes\b|\bdivided by\b|\bof\b)\s*\(?\s*-?\d|\b(?:sqrt|square root|average|mean|sum|total|percent(?:age)?|interest|discount|vat|tax|profit|loss|each|per|altogether|how much|how many)\b/i;
// Questions that need date arithmetic (a tool pass) vs. ones that only need today's date (no model call).
const DATE_LOGIC = /\b(?:how many (?:days|weeks|months|years)|day of the week|which day|what day (?:is|was|will)|weekday|days? (?:until|till|since|between|from|left|ago)|weeks? (?:until|till|from|ago)|months? (?:until|till|from|ago)|from now|years? old|how old|due date)\b|\b\d{4}-\d{2}-\d{2}\b/i;
const DATE_TODAY = /\b(?:today|tomorrow|yesterday|this (?:week|month|year)|next (?:week|month|year)|current date|what(?:'s| is) the date|deadline)\b/i;
const MAX_ROUNDS = 3;

/** Arithmetic in the message: an operator between numbers, or a money/maths word with at least two numbers. */
export function wantsArithmetic(text: string): boolean {
  text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'DATE'); // 2026-11-23 is a date, not a subtraction
  return ARITHMETIC.test(text) && (text.match(/\d+(?:[.,]\d+)*/g)?.length ?? 0) >= 2;
}

/** Needs date arithmetic (tool pass). */
export function wantsDateLogic(text: string): boolean {
  return DATE_LOGIC.test(text);
}

/** Depends on today's date at all (so never cached, and today's date is given to the model). */
export function mentionsDate(text: string): boolean {
  return DATE_LOGIC.test(text) || DATE_TODAY.test(text);
}

/** "What is 15% of 2400?" → "15% of 2400"; null if the message is more than an expression. */
export function bareExpression(text: string): string | null {
  const stripped = text
    .trim()
    .replace(/^(?:please\s+)?(?:what(?:'s| is)|calculate|compute|evaluate|how much is|work out|solve)\s*/i, '')
    .replace(/[?.!=\s]+$/, '');
  if (!/\d/.test(stripped) || stripped.length > 200 || /[a-z]{3,}/i.test(stripped.replace(/\b(?:of|percent|mod|times|divided by|plus|minus|sqrt|round|pi)\b/gi, ''))) {
    return null;
  }
  try {
    calculate(stripped);
    return stripped;
  } catch {
    return null;
  }
}

export interface ComputeResult {
  /** "calculate(…) = …" lines, in order. */
  results: string[];
  /** Text to add to the system prompt ('' when nothing was computed). */
  block: string;
  /** Whether a model call was used (vs. a direct evaluation). */
  usedModel: boolean;
}

function todayLine(now: Date): string {
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return `Today is ${weekday}, ${now.toISOString().slice(0, 10)} (UTC).`;
}

function block(results: string[], now: Date, dates: boolean): string {
  if (!results.length && !dates) return '';
  return [
    'Exact tool results for this request (computed deterministically — use these values, do not recompute or change them; ' +
    'if a needed value is missing, say it could not be computed instead of estimating):',
    ...(dates ? [`- ${todayLine(now)}`] : []),
    ...results.map((r) => `- ${r}`),
  ].join('\n');
}

/** Computes what the user's last message needs. Never throws: on any failure the model just gets no tool results. */
export async function computeForChat(
  messages: ChatMessage[],
  endpoints: Endpoint[],
  fetchImpl?: typeof fetch,
  now: () => Date = () => new Date(),
): Promise<ComputeResult> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? textOf(lastUser.content) : '';
  const arithmetic = wantsArithmetic(text);
  const dateLogic = wantsDateLogic(text);
  const dates = mentionsDate(text);
  if (!arithmetic && !dates) return { results: [], block: '', usedModel: false };

  const expr = arithmetic ? bareExpression(text) : null;
  if (expr || (!arithmetic && !dateLogic)) {
    if (!expr) return { results: [], block: block([], now(), true), usedModel: false };
    const results = [`calculate(${expr}) = ${formatNumber(calculate(expr))}`];
    return { results, block: block(results, now(), dates), usedModel: false };
  }

  const endpoint = endpoints[0];
  if (!endpoint || (endpoint.kind !== 'openai' && endpoint.kind !== 'anthropic')) {
    return { results: [], block: block([], now(), dates), usedModel: false };
  }
  const results: string[] = [];
  try {
    const recent = messages.filter((m) => m.role !== 'system').slice(-6);
    const transcript: AgentMessage[] = recent.map((m) =>
      m.role === 'assistant'
        ? { role: 'assistant' as const, text: textOf(m.content), toolCalls: [] }
        : { role: 'user' as const, text: textOf(m.content) }
    );
    const system = 'You prepare exact values for another assistant. For the user\'s LAST message, call calculate for every ' +
      'arithmetic step and date_math for every date question needed to answer it. Do not answer the user yourself. ' +
      `When everything needed has been computed, or nothing needs computing, reply "done". ${todayLine(now())}`;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const turn = await chatWithTools(endpoint, system, transcript, CALC_TOOLS, { fetchImpl, maxTokens: 300 });
      transcript.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw, rawKind: turn.rawKind });
      if (!turn.toolCalls.length) break;
      const toolResults = turn.toolCalls.map((call) => {
        const def = CALC_TOOLS.find((t) => t.name === call.name);
        const problems = def ? validate(def.parameters as unknown as JsonSchema, call.args) : [`unknown tool ${call.name}`];
        if (problems.length) return { id: call.id, name: call.name, content: `Invalid arguments: ${problems.join('; ')}`, isError: true };
        try {
          const out = runCalcTool(call.name, call.args, now);
          results.push(call.name === 'calculate' ? `calculate(${call.args.expression}) = ${out.split(' = ').at(-1)}` : `date_math(${JSON.stringify(call.args)}) = ${out}`);
          return { id: call.id, name: call.name, content: out };
        } catch (err) {
          return { id: call.id, name: call.name, content: (err as Error).message, isError: true };
        }
      });
      transcript.push({ role: 'tool', results: toolResults });
    }
  } catch (err) {
    console.warn('compute pass failed:', err instanceof Error ? err.message : err);
  }
  return { results, block: block(results, now(), dates), usedModel: true };
}
