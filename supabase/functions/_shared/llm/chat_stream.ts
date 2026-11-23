// Streaming chat for every provider, normalised to StreamEvent
// ({type: 'content' | 'thinking', text}).

import { readSseData, shortError } from '../http.ts';
import {
  ChatMessage,
  ContentPart,
  Endpoint,
  isRetryableStatus,
  ProviderError,
  StreamEvent,
  textOf,
} from './types.ts';

export interface ChatOptions {
  thinking?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const THINKING_BUDGET = 4000;

/** Claude models from before adaptive thinking (they take a fixed thinking budget). */
export function usesThinkingBudget(model: string): boolean {
  return /claude-(3|instant)|claude-(opus|sonnet|haiku)-4-[0-5]\b|claude-(opus|sonnet)-4-?\d{8}|claude-(opus|sonnet|haiku)-4$/.test(model);
}

/** Thinking settings for the Messages API: adaptive on current models, a budget on older ones. */
export function anthropicThinking(model: string): Record<string, unknown> {
  return usesThinkingBudget(model)
    ? { type: 'enabled', budget_tokens: THINKING_BUDGET }
    : { type: 'adaptive', display: 'summarized' };
}

export function streamChat(
  endpoint: Endpoint,
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<StreamEvent> {
  switch (endpoint.kind) {
    case 'anthropic':
      return streamAnthropic(endpoint, messages, options);
    case 'gemini':
      return streamGemini(endpoint, messages, options);
    default:
      return streamOpenAI(endpoint, messages, options);
  }
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: ChatOptions,
  label: string,
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`${label} is unreachable: ${shortError(reason, 200)}`, 502, true);
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    if (label === 'ARO model server' && (response.status === 401 || response.status === 403)) {
      // ARO's own server refused the server-side key: a configuration problem, not the user's.
      throw new ProviderError(
        "ARO's model server rejected the server key (ARO_MODEL_API_KEY in Supabase). " +
          'An admin needs to set a valid RunPod API key. Meanwhile, pick another model.',
        502,
        true,
      );
    }
    throw new ProviderError(
      `${label} error (${response.status}): ${shortError(text)}`,
      response.status,
      isRetryableStatus(response.status),
    );
  }
  return response;
}

// ---------------------------------------------------------------- Anthropic

export function toAnthropicContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text' ? { type: 'text', text: part.text } : {
      type: 'image',
      source: { type: 'base64', media_type: part.mimeType, data: part.data },
    }
  );
}

async function* streamAnthropic(
  endpoint: Endpoint,
  messages: ChatMessage[],
  options: ChatOptions,
): AsyncGenerator<StreamEvent> {
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const body: Record<string, unknown> = {
    model: endpoint.model,
    max_tokens: options.maxTokens ?? (options.thinking ? 16000 : 8192),
    stream: true,
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
  };
  if (system) body.system = system;
  if (options.thinking) body.thinking = anthropicThinking(endpoint.model);
  // Prompt caching: the cache breakpoint follows the end of the conversation,
  // so each new turn re-reads the earlier ones at a tenth of the price.
  body.cache_control = { type: 'ephemeral' };

  const response = await post(
    `${endpoint.baseUrl}/messages`,
    { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' },
    body,
    options,
    'Claude API',
  );

  const usage = { input: 0, output: 0, cached: 0 };
  for await (const payload of readSseData(response.body!)) {
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === 'error') {
      throw new ProviderError(`Claude API error: ${event.error?.message ?? 'unknown'}`, 502, false);
    }
    if (event.type === 'message_start' && event.message?.usage) {
      const u = event.message.usage;
      usage.cached = (u.cache_read_input_tokens ?? 0);
      usage.input = (u.input_tokens ?? 0) + usage.cached + (u.cache_creation_input_tokens ?? 0);
      usage.output = u.output_tokens ?? 0;
    }
    if (event.type === 'message_delta' && event.usage?.output_tokens != null) usage.output = event.usage.output_tokens;
    if (event.type !== 'content_block_delta') continue;
    if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      yield { type: 'thinking', text: event.delta.thinking };
    } else if (event.delta?.type === 'text_delta' && event.delta.text) {
      yield { type: 'content', text: event.delta.text };
    }
  }
  if (usage.input || usage.output) yield { type: 'usage', ...usage };
}

// ------------------------------------------------- OpenAI-compatible (+ ARO)

export function toOpenAIContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
  );
}

function openAIThinkingFields(endpoint: Endpoint, thinking: boolean): Record<string, unknown> {
  if (endpoint.provider === 'qwen') return { enable_thinking: thinking };
  // ARO runs Qwen3 under vLLM; its chat template takes enable_thinking.
  if (endpoint.provider === 'aro') return { chat_template_kwargs: { enable_thinking: thinking } };
  return {};
}

async function* streamOpenAI(
  endpoint: Endpoint,
  messages: ChatMessage[],
  options: ChatOptions,
): AsyncGenerator<StreamEvent> {
  const label = endpoint.provider === 'aro' ? 'ARO model server' : `${endpoint.provider} API`;
  const body = {
    model: endpoint.model,
    stream: true,
    // The final chunk then carries token usage (OpenAI, vLLM, DashScope, Gemini's OpenAI surface).
    stream_options: { include_usage: true },
    messages: messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) })),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...openAIThinkingFields(endpoint, options.thinking ?? false),
    ...(endpoint.extraBody ?? {}),
  };

  const response = await post(
    `${endpoint.baseUrl}/chat/completions`,
    { Authorization: `Bearer ${endpoint.apiKey}` },
    body,
    options,
    label,
  );

  let usage: StreamEvent | undefined;
  for await (const payload of readSseData(response.body!)) {
    if (payload === '[DONE]') break;
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.error) {
      throw new ProviderError(`${label} error: ${event.error.message ?? 'unknown'}`, 502, false);
    }
    if (event.usage && typeof event.usage.prompt_tokens === 'number') {
      usage = {
        type: 'usage',
        input: event.usage.prompt_tokens,
        output: event.usage.completion_tokens ?? 0,
        cached: event.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
    const delta = event.choices?.[0]?.delta;
    if (!delta) continue;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', text: reasoning };
    if (typeof delta.content === 'string' && delta.content) yield { type: 'content', text: delta.content };
  }
  if (usage) yield usage;
}

// ------------------------------------------------------------ Gemini native

function toGeminiParts(content: string | ContentPart[]): unknown[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((part) =>
    part.type === 'text' ? { text: part.text } : { inline_data: { mime_type: part.mimeType, data: part.data } }
  );
}

async function* streamGemini(
  endpoint: Endpoint,
  messages: ChatMessage[],
  options: ChatOptions,
): AsyncGenerator<StreamEvent> {
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const body: Record<string, unknown> = {
    contents: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: toGeminiParts(m.content) })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (options.thinking) body.generationConfig = { thinkingConfig: { includeThoughts: true } };

  const url = `${endpoint.baseUrl}/models/${encodeURIComponent(endpoint.model)}:streamGenerateContent?alt=sse`;
  const response = await post(url, { 'x-goog-api-key': endpoint.apiKey }, body, options, 'Gemini API');

  let usage: StreamEvent | undefined;
  for await (const payload of readSseData(response.body!)) {
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.error) {
      throw new ProviderError(`Gemini API error: ${event.error.message ?? 'unknown'}`, 502, false);
    }
    const meta = event.usageMetadata;
    if (meta && typeof meta.promptTokenCount === 'number') {
      usage = {
        type: 'usage',
        input: meta.promptTokenCount,
        output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
        cached: meta.cachedContentTokenCount ?? 0,
      };
    }
    for (const part of event.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.text !== 'string' || !part.text) continue;
      yield { type: part.thought ? 'thinking' : 'content', text: part.text };
    }
  }
  if (usage) yield usage;
}
