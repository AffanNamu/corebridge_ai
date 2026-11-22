// One model turn with tool calling, normalised across providers.
// Anthropic speaks the Messages API; OpenAI, Qwen, Gemini (OpenAI-compatible
// surface) and ARO (vLLM) speak Chat Completions.

import { shortError } from '../http.ts';
import { type Endpoint, isRetryableStatus, ProviderError } from './types.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type AgentMessage =
  | { role: 'user'; text: string }
  | {
    role: 'assistant';
    text: string;
    toolCalls: ToolCall[];
    /** Provider-native message, replayed verbatim (keeps thinking signatures). */
    raw?: unknown;
    rawKind?: string;
  }
  | { role: 'tool'; results: ToolResult[] };

export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  rawKind: string;
}

export interface ToolChatOptions {
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function chatWithTools(
  endpoint: Endpoint,
  system: string,
  transcript: AgentMessage[],
  tools: ToolDefinition[],
  options: ToolChatOptions = {},
): Promise<AssistantTurn> {
  return endpoint.kind === 'anthropic'
    ? await anthropicTurn(endpoint, system, transcript, tools, options)
    : await openAITurn(endpoint, system, transcript, tools, options);
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: ToolChatOptions,
  label: string,
): Promise<any> {
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
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `${label} error (${response.status}): ${shortError(text)}`,
      response.status,
      isRetryableStatus(response.status),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${label} returned invalid JSON`, 502, false);
  }
}

// ---------------------------------------------------------------- Anthropic

export function toAnthropicMessages(transcript: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of transcript) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      if (message.rawKind === 'anthropic' && Array.isArray(message.raw)) {
        out.push({ role: 'assistant', content: message.raw });
        continue;
      }
      const content: unknown[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '…' }] });
    } else {
      out.push({
        role: 'user',
        content: message.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

async function anthropicTurn(
  endpoint: Endpoint,
  system: string,
  transcript: AgentMessage[],
  tools: ToolDefinition[],
  options: ToolChatOptions,
): Promise<AssistantTurn> {
  const data = await postJson(
    `${endpoint.baseUrl}/messages`,
    { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: endpoint.model,
      max_tokens: options.maxTokens ?? 8192,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: toAnthropicMessages(transcript),
    },
    options,
    'Claude API',
  );

  const blocks: any[] = Array.isArray(data.content) ? data.content : [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    toolCalls: blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: String(b.id), name: String(b.name), args: isObject(b.input) ? b.input : {} })),
    raw: blocks,
    rawKind: 'anthropic',
  };
}

// ------------------------------------------------- OpenAI-compatible (+ ARO)

export function toOpenAIMessages(system: string, transcript: AgentMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const message of transcript) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.text });
    } else if (message.role === 'assistant') {
      if (message.rawKind === 'openai' && isObject(message.raw)) {
        out.push(message.raw);
        continue;
      }
      out.push({
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length
          ? {
            tool_calls: message.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
          : {}),
      });
    } else {
      for (const r of message.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
    }
  }
  return out;
}

async function openAITurn(
  endpoint: Endpoint,
  system: string,
  transcript: AgentMessage[],
  tools: ToolDefinition[],
  options: ToolChatOptions,
): Promise<AssistantTurn> {
  const label = endpoint.provider === 'aro' ? 'ARO model server' : `${endpoint.provider} API`;
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: toOpenAIMessages(system, transcript),
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: 'auto',
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    // DashScope rejects thinking on non-streaming calls.
    ...(endpoint.provider === 'qwen' ? { enable_thinking: false } : {}),
    ...(endpoint.extraBody ?? {}),
  };

  const data = await postJson(
    `${endpoint.baseUrl}/chat/completions`,
    { Authorization: `Bearer ${endpoint.apiKey}` },
    body,
    options,
    label,
  );

  const message = data.choices?.[0]?.message ?? {};
  const rawCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawCalls.map((call, index) => ({
    id: String(call.id ?? `call_${index}`),
    name: String(call.function?.name ?? ''),
    args: parseArgs(call.function?.arguments),
  }));

  // Replay only what the API accepts back; keep provider extras such as
  // Gemini's thought signatures inside each tool call.
  const raw: Record<string, unknown> = { role: 'assistant', content: message.content ?? null };
  if (rawCalls.length) {
    raw.tool_calls = rawCalls.map((call, index) => ({ ...call, id: toolCalls[index].id, type: 'function' }));
  }

  return {
    text: typeof message.content === 'string' ? message.content.trim() : '',
    toolCalls,
    raw,
    rawKind: 'openai',
  };
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return { _invalid_json: value };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
