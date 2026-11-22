// ai-router: streams chat replies from ARO AI's own models or the user's
// own Claude / OpenAI / Gemini / Qwen key, lists models a key can use, and
// returns the user's plan overview. Auth is a Firebase ID token.
//
// Request body (POST, JSON):
//   { action?: 'complete' | 'listModels' | 'overview', provider, model?,
//     messages?, apiKey?, thinkingEnabled?, capability? }
//
// For provider 'aro', `model` is an ARO model id ('aro-1.5', 'aro-code',
// 'aro-research', 'aro-translate', 'aro-vision') or 'auto' — the central
// router then picks the specialist. Every ARO request is checked against
// the user's plan in Postgres before any model is called.
//
// 'complete' replies with SSE frames:
//   data: {"meta": {"servedBy", "model", "aroModel"?, "routed"?, "notice"?, "usage"?}}
//   data: {"thinking": "..."}   // reasoning, when the provider exposes it
//   data: {"delta": "..."}      // answer text
//   data: {"error": "..."}
//   data: [DONE]

import { type AroResolution, canTryNext, resolveAro } from '../_shared/aro.ts';
import { type Db, dbFromEnv } from '../_shared/db.ts';
import { isAdmin, overview, refund } from '../_shared/entitlements.ts';
import type { VerifiedUser } from '../_shared/firebase-auth.ts';
import { CORS_HEADERS, errorResponse, jsonResponse, SSE_DONE, SSE_HEADERS, sseFrame } from '../_shared/http.ts';
import { streamChat } from '../_shared/llm/chat_stream.ts';
import { Capability, listModels } from '../_shared/llm/list_models.ts';
import { resolveEndpoints } from '../_shared/llm/providers.ts';
import { type ChatMessage, type ContentPart, type Endpoint, isProviderId, ProviderError } from '../_shared/llm/types.ts';

export interface RouterDeps {
  verify: (req: Request) => Promise<VerifiedUser | null>;
  env?: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  /** Entitlements database. Undefined = from env; null = not configured. */
  db?: Db | null;
}

const MAX_MESSAGES = 200;
const MAX_TOTAL_CHARS = 400_000;

export async function handleRequest(req: Request, deps: RouterDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  const user = await deps.verify(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const db = deps.db === undefined ? dbFromEnv(env) : deps.db;

  if (body?.action === 'overview') {
    if (!db) return errorResponse("Plans aren't set up on the server yet.", 503);
    try {
      return jsonResponse({ ...(await overview(db, user.uid)), is_admin: isAdmin(user.uid, env) });
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Database error', 502);
    }
  }

  const provider = body?.provider;
  if (!isProviderId(provider)) {
    return errorResponse('provider must be one of: aro, claude, openai, gemini, qwen', 400);
  }

  if (body.action === 'listModels') {
    try {
      const capability: Capability = body.capability === 'vision' ? 'vision' : 'chat';
      const models = await listModels(provider, body.apiKey, capability, deps.fetchImpl, deps.env);
      return jsonResponse({ models });
    } catch (err) {
      return providerErrorResponse(err);
    }
  }

  const messages = parseMessages(body.messages);
  if (typeof messages === 'string') return errorResponse(messages, 400);

  let endpoints: Endpoint[];
  let aro: AroResolution | undefined;
  try {
    if (provider === 'aro') {
      aro = await resolveAro(db, user.uid, body.model, messages, env);
      endpoints = aro.endpoints;
    } else {
      endpoints = resolveEndpoints(provider, body.model, body.apiKey, 'chat', env);
    }
  } catch (err) {
    return providerErrorResponse(err);
  }

  const finalMessages: ChatMessage[] = aro
    ? [{ role: 'system', content: aro.systemPrompt }, ...messages.filter((m) => m.role !== 'system')]
    : messages;
  const thinking = body.thinkingEnabled === true;
  const metaExtra = aro
    ? {
      aroModel: aro.aroModel,
      routed: aro.routed,
      ...(aro.notice ? { notice: aro.notice } : {}),
      usage: {
        plan: aro.authorization.plan,
        via: aro.authorization.via,
        limit: aro.authorization.limit ?? null,
        remaining: aro.authorization.remaining ?? null,
        credits: aro.authorization.credits ?? null,
      },
    }
    : {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answered = false;
      try {
        await streamWithFallback(endpoints, finalMessages, thinking, deps.fetchImpl, (frame) => {
          answered = true;
          controller.enqueue(frame);
        }, metaExtra);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown streaming error';
        controller.enqueue(sseFrame({ error: message }));
        // Nothing was answered: give the request (or credits) back.
        if (aro && db && !answered) {
          await refund(db, user.uid, aro.aroModel, aro.authorization.via).catch((e) =>
            console.error('ai-router: refund failed', e)
          );
        }
      } finally {
        controller.enqueue(SSE_DONE);
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * Tries each endpoint in order. Moves to the next one only if the current
 * one failed before producing any output, so users never see two answers
 * glued together.
 */
export async function streamWithFallback(
  endpoints: Endpoint[],
  messages: ChatMessage[],
  thinking: boolean,
  fetchImpl: typeof fetch | undefined,
  emit: (frame: Uint8Array) => void,
  metaExtra: Record<string, unknown> = {},
): Promise<void> {
  let lastError: unknown;
  for (const [index, endpoint] of endpoints.entries()) {
    let started = false;
    try {
      for await (const event of streamChat(endpoint, messages, { thinking, fetchImpl })) {
        if (!started) {
          started = true;
          emit(sseFrame({ meta: { servedBy: endpoint.servedBy, model: endpoint.model, ...metaExtra } }));
        }
        emit(sseFrame(event.type === 'thinking' ? { thinking: event.text } : { delta: event.text }));
      }
      if (!started) emit(sseFrame({ meta: { servedBy: endpoint.servedBy, model: endpoint.model, ...metaExtra } }));
      return;
    } catch (err) {
      lastError = err;
      const canRetry = !started && canTryNext(err) && index < endpoints.length - 1;
      if (!canRetry) throw err;
      console.warn(`ai-router: ${endpoint.servedBy} failed, trying next endpoint: ${(err as Error).message}`);
    }
  }
  throw lastError;
}

export function parseMessages(raw: unknown): ChatMessage[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'messages must be a non-empty array';
  if (raw.length > MAX_MESSAGES) return `Too many messages (max ${MAX_MESSAGES})`;

  let totalChars = 0;
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    const role = item?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return `Invalid message role: ${role}`;

    if (typeof item.content === 'string') {
      totalChars += item.content.length;
      messages.push({ role, content: item.content });
      continue;
    }
    if (!Array.isArray(item.content)) return 'Message content must be a string or an array of parts';

    const parts: ContentPart[] = [];
    for (const part of item.content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        totalChars += part.text.length;
        parts.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
        if (!/^image\/(png|jpe?g|webp|gif)$/.test(part.mimeType)) return `Unsupported image type: ${part.mimeType}`;
        parts.push({ type: 'image', mimeType: part.mimeType, data: part.data });
      } else {
        return 'Invalid message part';
      }
    }
    messages.push({ role, content: parts });
  }

  if (totalChars > MAX_TOTAL_CHARS) return 'Conversation is too long — start a new chat.';
  return messages;
}

function providerErrorResponse(err: unknown): Response {
  if (err instanceof ProviderError) return errorResponse(err.message, err.status >= 400 ? err.status : 502);
  return errorResponse(err instanceof Error ? err.message : 'Unknown error', 500);
}
