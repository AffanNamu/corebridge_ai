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
  if (options.thinking) body.thinking = { type: 'enabled', budget_tokens: THINKING_BUDGET };

  const response = await post(
    `${endpoint.baseUrl}/messages`,
    { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' },
    body,
    options,
    'Claude API',
  );

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
    if (event.type !== 'content_block_delta') continue;
    if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      yield { type: 'thinking', text: event.delta.thinking };
    } else if (event.delta?.type === 'text_delta' && event.delta.text) {
      yield { type: 'content', text: event.delta.text };
    }
  }
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

  for await (const payload of readSseData(response.body!)) {
    if (payload === '[DONE]') return;
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.error) {
      throw new ProviderError(`${label} error: ${event.error.message ?? 'unknown'}`, 502, false);
    }
    const delta = event.choices?.[0]?.delta;
    if (!delta) continue;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', text: reasoning };
    if (typeof delta.content === 'string' && delta.content) yield { type: 'content', text: delta.content };
  }
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
    for (const part of event.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.text !== 'string' || !part.text) continue;
      yield { type: part.thought ? 'thinking' : 'content', text: part.text };
    }
  }
}
