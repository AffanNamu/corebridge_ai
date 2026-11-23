// Detects which models a user's key can actually use, ranked best-first.
// Called by the app right after a key is saved (ApiProvidersScreen).

import { shortError } from '../http.ts';
import { qwenBaseUrl } from './providers.ts';
import { ProviderError, ProviderId } from './types.ts';

export type Capability = 'chat' | 'vision';

type Env = (name: string) => string | undefined;

export async function listModels(
  provider: ProviderId,
  apiKey: string | undefined,
  capability: Capability = 'chat',
  fetchImpl: typeof fetch = fetch,
  env: Env = (name) => Deno.env.get(name),
): Promise<string[]> {
  // ARO's chat models; which ones a user may use is decided per request by their plan.
  if (provider === 'aro') return ['auto', 'aro-1.5', 'aro-code', 'aro-research', 'aro-translate', 'aro-vision'];

  const key = apiKey?.trim();
  if (!key) throw new ProviderError(`No API key provided for ${provider}.`, 400, false);

  switch (provider) {
    case 'claude': {
      const data = await getJson(fetchImpl, 'https://api.anthropic.com/v1/models?limit=100', {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      });
      return rankClaude(ids(data?.data));
    }
    case 'openai': {
      const data = await getJson(fetchImpl, 'https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
      return rankOpenAI(ids(data?.data));
    }
    case 'gemini': {
      const data = await getJson(
        fetchImpl,
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        { 'x-goog-api-key': key },
      );
      const usable = (data?.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m: any) => String(m.name ?? '').replace(/^models\//, ''));
      return rankGemini(usable);
    }
    case 'qwen': {
      const data = await getJson(fetchImpl, `${qwenBaseUrl(key, env)}/models`, { Authorization: `Bearer ${key}` });
      return rankQwen(ids(data?.data), capability);
    }
  }
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ProviderError(`Model listing failed (${response.status}): ${shortError(text)}`, response.status, false);
  }
  return await response.json();
}

function ids(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((m: any) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean);
}

/** Sorts by family priority, then newest-looking id first. */
function rankBy(models: string[], priorities: RegExp[]): string[] {
  const score = (id: string) => {
    const index = priorities.findIndex((re) => re.test(id));
    return index === -1 ? priorities.length : index;
  };
  return [...new Set(models)].sort((a, b) => score(a) - score(b) || b.localeCompare(a, undefined, { numeric: true }));
}

export function rankClaude(models: string[]): string[] {
  return rankBy(models.filter((id) => id.startsWith('claude')), [/opus/, /sonnet/, /haiku/]);
}

const OPENAI_EXCLUDE =
  /(embedding|whisper|tts|audio|realtime|transcribe|search|moderation|dall-e|image|davinci|babbage|instruct)/;

/** GPT chat models, full-size before mini/nano/lite. */
export function rankOpenAI(models: string[]): string[] {
  const chat = models.filter((id) => id.startsWith('gpt') && !OPENAI_EXCLUDE.test(id));
  return rankBy(chat, [/^(?!.*(mini|nano|lite|fast))/, /./]);
}

const GEMINI_EXCLUDE = /(embedding|aqa|imagen|tts|image|live|native-audio|learnlm)/;

export function rankGemini(models: string[]): string[] {
  const chat = models.filter((id) => id.startsWith('gemini') && !GEMINI_EXCLUDE.test(id));
  return rankBy(chat, [/pro/, /flash(?!-lite)/, /lite/]);
}

export function rankQwen(models: string[], capability: Capability): string[] {
  const vision = /(^|[-_])vl([-_]|$)|-vl-|qvq|omni/i;
  if (capability === 'vision') return rankBy(models.filter((id) => vision.test(id)), [/max/, /plus/, /turbo/]);
  const chat = models.filter((id) =>
    /^qwen/i.test(id) && !vision.test(id) && !/(image|embedding|tts|asr|speech|audio|video|rerank|mt-)/i.test(id)
  );
  return rankBy(chat, [/max/, /plus/, /turbo|flash/]);
}
