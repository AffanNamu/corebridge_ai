// Cost guardrails shared by ai-router and aro-agent:
//   gate()         per-user rate limits (every provider) + daily GPU budget (ARO)
//   fitToContext() keeps a conversation inside the model's context window
//   logUsage()     one trace row per model call (tokens, latency, cost) + budget alerts
//   cacheKey()     key for the exact-match response cache
//
// Decisions and counters live in Postgres (supabase/migrations/*_aro_cost_controls.sql)
// so concurrent requests can't race past a limit.

import type { Db } from './db.ts';
import { type ChatMessage, type ContentPart, ProviderError, textOf } from './llm/types.ts';

type Env = (name: string) => string | undefined;

// ------------------------------------------------------------------- gate

export interface GateResult {
  allowed: boolean;
  reason?: 'rate_limited' | 'budget_exceeded';
  window?: 'minute' | 'hour';
  limit?: number;
  retry_after_s?: number;
  plan?: string;
  max_output_tokens?: number;
  agent_max_steps?: number;
  agent_max_tokens?: number;
}

/**
 * Counts one request and throws a user-facing 429 when the user is over
 * their plan's rate limit, or (for ARO's own GPUs) the daily budget is used up.
 * Without a database, everything is allowed.
 */
export async function gate(db: Db | null, userId: string, ownGpu: boolean): Promise<GateResult> {
  if (!db) return { allowed: true };
  let result: GateResult;
  try {
    result = await db.rpc<GateResult>('aro_gate', { p_user: userId, p_own_gpu: ownGpu });
  } catch (err) {
    // Database trouble: requests paid by the user's own key go through; ARO's
    // own GPUs stay closed (their plan check needs the database anyway).
    if (!ownGpu) {
      console.error('rate-limit check failed, allowing BYOK request:', err instanceof Error ? err.message : err);
      return { allowed: true };
    }
    throw err;
  }
  if (result.allowed) return result;
  throw new GateError(gateMessage(result), result);
}

export class GateError extends ProviderError {
  constructor(message: string, readonly gate: GateResult) {
    super(message, 429, false);
    this.name = 'GateError';
  }
}

function wait(seconds = 60): string {
  if (seconds < 90) return `${Math.max(1, seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
}

export function gateMessage(result: GateResult): string {
  if (result.reason === 'budget_exceeded') {
    return "ARO's models are at capacity for today. Try again later, upgrade your plan for priority, " +
      'or pick Claude, ChatGPT, Gemini or Qwen with your own key.';
  }
  return `You're sending messages too quickly (${result.limit} per ${result.window ?? 'minute'} on your plan). ` +
    `Try again in ${wait(result.retry_after_s)}.`;
}

// ------------------------------------------------------- context fitting

/** Rough token count: ~3 characters per token (conservative for code and non-English text). */
export function estimateTokens(content: string | ContentPart[]): number {
  if (typeof content === 'string') return Math.ceil(content.length / 3) + 4;
  return content.reduce((sum, p) => sum + (p.type === 'text' ? Math.ceil(p.text.length / 3) : 800), 4);
}

export interface FitResult {
  messages: ChatMessage[];
  droppedMessages: number;
  truncated: boolean;
}

/**
 * Keeps the system prompt and the newest messages within `maxInputTokens`:
 * drops the oldest turns first, then shortens the middle of the newest
 * message if it alone is still too long.
 */
export function fitToContext(messages: ChatMessage[], maxInputTokens: number): FitResult {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  let budget = maxInputTokens - system.reduce((s, m) => s + estimateTokens(m.content), 0);

  const kept: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content);
    if (cost > budget && kept.length > 0) break;
    kept.unshift(rest[i]);
    budget -= cost;
  }
  // A conversation must not start with the assistant.
  while (kept.length > 1 && kept[0].role === 'assistant') kept.shift();

  let truncated = false;
  if (budget < 0 && kept.length > 0) {
    const last = kept[kept.length - 1];
    const allowedChars = Math.max(200, (estimateTokens(last.content) + budget) * 3);
    kept[kept.length - 1] = { ...last, content: shortenMiddle(textOf(last.content), allowedChars) };
    truncated = true;
  }
  return { messages: [...system, ...kept], droppedMessages: rest.length - kept.length, truncated };
}

function shortenMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '\n\n[… middle of this message removed to fit the model …]\n\n';
  const half = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  return text.slice(0, half) + marker + text.slice(text.length - half);
}

/** ARO's context window (tokens), from ARO_CONTEXT_TOKENS; must match the server's MAX_MODEL_LEN. */
export function aroContextTokens(env: Env): number {
  const n = Number(env('ARO_CONTEXT_TOKENS') ?? '');
  return Number.isFinite(n) && n >= 2048 ? n : 32768;
}

// ----------------------------------------------------------------- usage

export interface Usage {
  input: number;
  output: number;
  cached?: number;
}

export interface UsageEvent {
  traceId: string;
  userId: string;
  surface: 'chat' | 'agent';
  provider: string;
  model: string;
  servedBy: string;
  aroModel?: string;
  usage?: Usage;
  latencyMs: number;
  status?: 'ok' | 'error' | 'cache_hit' | 'stopped';
}

interface LogResult {
  cost_usd: number;
  spent_today_usd: number;
  budget_usd: number;
  alerts: { threshold: number; spent_usd: number; budget_usd: number }[];
}

/**
 * Records one model call. Never throws: logging must not break a reply.
 * Sends a budget alert to ARO_ALERT_WEBHOOK_URL (Slack/Discord-style) when
 * a threshold is crossed.
 */
export async function logUsage(
  db: Db | null,
  event: UsageEvent,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<LogResult | null> {
  if (!db) return null;
  try {
    const result = await db.rpc<LogResult>('aro_log_usage', {
      p_event: {
        trace_id: event.traceId,
        user_id: event.userId,
        surface: event.surface,
        provider: event.provider,
        model: event.model,
        served_by: event.servedBy,
        aro_model: event.aroModel ?? null,
        input_tokens: Math.round(event.usage?.input ?? 0),
        output_tokens: Math.round(event.usage?.output ?? 0),
        cached_tokens: Math.round(event.usage?.cached ?? 0),
        latency_ms: Math.round(event.latencyMs),
        status: event.status ?? 'ok',
      },
    });
    if (result?.alerts?.length) await sendAlerts(result.alerts, env, fetchImpl);
    return result;
  } catch (err) {
    console.error('usage log failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function sendAlerts(alerts: LogResult['alerts'], env: Env, fetchImpl: typeof fetch): Promise<void> {
  for (const a of alerts) {
    const pct = Math.round(Number(a.threshold) * 100);
    const text = `ARO AI spending alert: ${pct}% of today's GPU budget used ` +
      `($${Number(a.spent_usd).toFixed(2)} of $${Number(a.budget_usd).toFixed(2)}).` +
      (pct >= 100 ? ' Free-plan ARO requests are paused until midnight UTC.' : '');
    console.warn(text);
    const url = env('ARO_ALERT_WEBHOOK_URL')?.trim();
    if (!url) continue;
    try {
      await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text }), // Slack reads `text`, Discord `content`
      });
    } catch (err) {
      console.error('alert webhook failed:', err instanceof Error ? err.message : err);
    }
  }
}

// ----------------------------------------------------------------- cache

/** Whether a request may use the exact-match cache: one short text question, no thinking. */
export function cacheable(messages: ChatMessage[], thinking: boolean): boolean {
  const turns = messages.filter((m) => m.role !== 'system');
  return !thinking && turns.length === 1 && turns[0].role === 'user' &&
    typeof turns[0].content === 'string' && turns[0].content.trim().length > 0 && turns[0].content.length <= 2000;
}

export async function cacheKey(model: string, messages: ChatMessage[]): Promise<string> {
  const normalised = messages.map((m) => [m.role, textOf(m.content).trim().replace(/\s+/g, ' ').toLowerCase()]);
  const bytes = new TextEncoder().encode(JSON.stringify([model, normalised]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheGet(db: Db | null, key: string): Promise<string | null> {
  if (!db) return null;
  try {
    return await db.rpc<string | null>('aro_cache_get', { p_key: key });
  } catch {
    return null;
  }
}

export async function cachePut(db: Db | null, key: string, model: string, response: string): Promise<void> {
  if (!db) return;
  await db.rpc('aro_cache_put', { p_key: key, p_model: model, p_response: response }).catch(() => {});
}
