// Resolves a provider choice from the app into concrete endpoints.
//
// - claude / openai / gemini / qwen: BYOK — the user's own key, sent per request.
// - aro: ARO AI's own models — resolved by _shared/aro.ts, which checks the
//   user's plan first. They never go through this function.

import { Endpoint, ProviderError, ProviderId } from './types.ts';

export const ARO_DISPLAY_NAME = 'ARO 1.5';

export const ARO_SYSTEM_PROMPT =
  'You are ARO, the assistant built into ARO AI. Your model is ARO 1.5, developed by ARO Group. ' +
  'Be accurate, concise and helpful. If you are not sure about something, say so.';

type Env = (name: string) => string | undefined;

const defaultEnv: Env = (name) => Deno.env.get(name);

const BYOK_BASE_URLS: Record<Exclude<ProviderId, 'aro'>, string> = {
  claude: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
};

// Alibaba Model Studio workspace keys (sk-ws-…) live on a workspace endpoint,
// not the public DashScope one. Matches the previously deployed ai-router.
const QWEN_WORKSPACE_BASE_URL = 'https://ws-69hcvs1v8zn9hum7.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

export function qwenBaseUrl(apiKey: string, env: Env = defaultEnv): string {
  if (apiKey.startsWith('sk-ws-')) return (env('QWEN_WORKSPACE_BASE_URL') || QWEN_WORKSPACE_BASE_URL).replace(/\/+$/, '');
  return BYOK_BASE_URLS.qwen;
}

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
  if (provider === 'aro') {
    throw new ProviderError('ARO models are resolved by resolveAro (entitlement check).', 500, false);
  }

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
    baseUrl: provider === 'qwen' ? qwenBaseUrl(key, env) : BYOK_BASE_URLS[provider],
    apiKey: key,
    model: model.trim(),
    servedBy: provider,
  }];
}
