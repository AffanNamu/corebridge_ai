// Provider-neutral types used by ai-router (chat) and aro-agent (tools).

export type ProviderId = 'aro' | 'claude' | 'openai' | 'gemini' | 'qwen';

export const PROVIDER_IDS: readonly ProviderId[] = ['aro', 'claude', 'openai', 'gemini', 'qwen'];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Wire protocol a provider speaks. */
export type ProviderKind = 'anthropic' | 'openai' | 'gemini';

export interface TextPart {
  type: 'text';
  text: string;
}

/** Image sent by the app as base64 (see ConversationRepositoryImpl._buildUserTurn). */
export interface ImagePart {
  type: 'image';
  mimeType: string;
  data: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** A resolved, ready-to-call endpoint. */
export interface Endpoint {
  provider: ProviderId;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Who actually answers: 'aro' (our own model), 'fallback', or the user's provider. */
  servedBy: string;
  /** Extra JSON merged into OpenAI-compatible request bodies. */
  extraBody?: Record<string, unknown>;
}

export interface StreamEvent {
  type: 'content' | 'thinking';
  text: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when nothing was produced yet and another endpoint may be tried. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
