// Resolves a provider choice from the app into concrete endpoints.
//
// - claude / openai / gemini / qwen: BYOK — the user's own key, sent per request.
// - aro: ARO AI's own model (ARO 1.5). Runs on an OpenAI-compatible server
//   (vLLM) that the ARO team operates, so users need no key. Configured with
//   Supabase secrets; an optional fallback endpoint keeps chat working while
//   the ARO server is offline (for example, a Colab test session that ended).

import { Endpoint, ProviderError, ProviderId } from './types.ts';

export const ARO_DISPLAY_NAME = 'ARO 1.5';

export const ARO_SYSTEM_PROMPT =
  'You are ARO, the assistant built into ARO AI. Your model is ARO 1.5. ' +
  'Be accurate, concise and helpful. If you are not sure about something, say so.';

type Env = (name: string) => string | undefined;

const defaultEnv: Env = (name) => Deno.env.get(name);

const BYOK_BASE_URLS: Record<Exclude<ProviderId, 'aro'>, string> = {
  claude: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
};

/** Gemini's OpenAI-compatible surface, used for tool calling in aro-agent. */
export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * Returns the endpoints to try, in order. For BYOK providers that is just
 * the user's provider; for ARO it is the ARO server and then the fallback.
 *
 * `purpose` picks the wire format: chat uses Gemini's native API (thinking
 * and images), while the agent uses Gemini's OpenAI-compatible API (tools).
 */
export function resolveEndpoints(
  provider: ProviderId,
  model: string | undefined,
  apiKey: string | undefined,
  purpose: 'chat' | 'agent' = 'chat',
  env: Env = defaultEnv,
): Endpoint[] {
  if (provider === 'aro') return resolveAro(env);

  const key = apiKey?.trim();
  if (!key) {
    throw new ProviderError(
      `No API key provided for ${provider}. Add one in Settings → AI Providers.`,
      400,
      false,
    );
  }
  if (!model?.trim()) throw new ProviderError('Missing model', 400, false);

  if (provider === 'gemini') {
    return [{
      provider,
      kind: purpose === 'agent' ? 'openai' : 'gemini',
      baseUrl: purpose === 'agent' ? GEMINI_OPENAI_BASE_URL : BYOK_BASE_URLS.gemini,
      apiKey: key,
      model: model.trim(),
      servedBy: provider,
    }];
  }

  return [{
    provider,
    kind: provider === 'claude' ? 'anthropic' : 'openai',
    baseUrl: BYOK_BASE_URLS[provider],
    apiKey: key,
    model: model.trim(),
    servedBy: provider,
  }];
}

function resolveAro(env: Env): Endpoint[] {
  const endpoints: Endpoint[] = [];

  const baseUrl = env('ARO_MODEL_BASE_URL')?.trim();
  if (baseUrl) {
    endpoints.push({
      provider: 'aro',
      kind: 'openai',
      baseUrl: stripSlash(baseUrl),
      apiKey: env('ARO_MODEL_API_KEY')?.trim() || 'aro-no-key',
      model: env('ARO_MODEL_NAME')?.trim() || 'aro-1.5',
      servedBy: 'aro',
    });
  }

  const fallbackUrl = env('ARO_FALLBACK_BASE_URL')?.trim();
  const fallbackModel = env('ARO_FALLBACK_MODEL')?.trim();
  if (fallbackUrl && fallbackModel) {
    endpoints.push({
      provider: 'aro',
      kind: 'openai',
      baseUrl: stripSlash(fallbackUrl),
      apiKey: env('ARO_FALLBACK_API_KEY')?.trim() || 'aro-no-key',
      model: fallbackModel,
      servedBy: 'fallback',
    });
  }

  if (endpoints.length === 0) {
    throw new ProviderError(
      `${ARO_DISPLAY_NAME} is not available yet. Please pick another model for now.`,
      503,
      false,
    );
  }
  return endpoints;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
