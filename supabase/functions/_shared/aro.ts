// The central ARO model router: picks the right ARO model for a request,
// checks the user's entitlement in Postgres, and resolves where to send it.
//
// Text models (ARO 1.5, Code, Research, Translate) are LoRA adapters on one
// vLLM server (ARO_MODEL_BASE_URL). ARO Vision runs on its own server
// (ARO_VISION_BASE_URL). A specialist whose adapter isn't published yet
// answers through ARO 1.5 on the same server.

import type { Db } from './db.ts';
import { type Authorization, authorize, denialMessage, refund } from './entitlements.ts';
import { ARO_SYSTEM_PROMPT } from './llm/providers.ts';
import { type ChatMessage, type Endpoint, ProviderError, textOf } from './llm/types.ts';

export const ARO_MODEL_IDS = ['aro-1.5', 'aro-code', 'aro-research', 'aro-vision', 'aro-voice', 'aro-creative', 'aro-translate'] as const;
export type AroModelId = typeof ARO_MODEL_IDS[number];

const NAMES: Record<AroModelId, string> = {
  'aro-1.5': 'ARO 1.5',
  'aro-code': 'ARO Code',
  'aro-research': 'ARO Research',
  'aro-vision': 'ARO Vision',
  'aro-voice': 'ARO Voice',
  'aro-creative': 'ARO Creative',
  'aro-translate': 'ARO Translate',
};

export function aroName(id: string): string {
  return NAMES[id as AroModelId] ?? id;
}

export function isAroModelId(value: unknown): value is AroModelId {
  return typeof value === 'string' && (ARO_MODEL_IDS as readonly string[]).includes(value);
}

// ------------------------------------------------------------ auto routing

const LANGUAGES = 'hausa|yoruba|igbo|pidgin|fulfulde|fula|swahili|kiswahili|amharic|wolof|zulu|xhosa|arabic|french|english';

const RULES: { model: AroModelId; patterns: RegExp[] }[] = [
  {
    model: 'aro-translate',
    patterns: [
      new RegExp(`\\b(translate|translation|fassara|traduire|tafsiri)\\b`, 'i'),
      new RegExp(`\\b(in|into|to)\\s+(${LANGUAGES})\\b`, 'i'),
      new RegExp(`\\bhow do (you|i) say\\b`, 'i'),
      new RegExp(`\\bwhat (language|lang) is\\b`, 'i'),
    ],
  },
  {
    model: 'aro-code',
    patterns: [
      /```/,
      /\b(code|coding|function|bug|debug|error|exception|stack ?trace|traceback|compile|refactor|unit tests?|regex|api|endpoint|sql|database|query|git|repo(sitory)?)\b/i,
      /\b(python|javascript|typescript|dart|flutter|kotlin|java|swift|rust|golang|c\+\+|c#|php|react|node\.?js|django|laravel|html|css)\b/i,
      /\b(def |class |import |const |let |=>|console\.log|print\()/,
    ],
  },
  {
    model: 'aro-research',
    patterns: [
      /\b(prove|proof|theorem|lemma|derive|derivative|integral|equation|calculus|algebra|probability|statistic(s|al)|hypothesis|experiment|research|thesis|dissertation|paper|journal|citation|physics|chemistry|biology|engineering)\b/i,
      /\b(solve|calculate|compute)\b.*\d/i,
      /[∫∑√π≤≥≠∞]|\^\d|\\frac|\\sum/,
    ],
  },
];

export interface Route {
  model: AroModelId;
  reason: string;
}

/** Picks the specialist for "ARO (Auto)". Images → Vision; otherwise by topic; default ARO 1.5. */
export function routeAroModel(messages: ChatMessage[], hasImages: boolean): Route {
  if (hasImages) return { model: 'aro-vision', reason: 'image attached' };
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? textOf(lastUser.content) : '';
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) return { model: rule.model, reason: 'topic' };
  }
  return { model: 'aro-1.5', reason: 'general' };
}

export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'));
}

// ------------------------------------------------------- access + endpoints

export interface AroResolution {
  aroModel: AroModelId;
  authorization: Authorization;
  endpoints: Endpoint[];
  systemPrompt: string;
  routed: boolean;
  /** Shown to the user, e.g. when Auto had to use ARO 1.5 instead of a specialist. */
  notice?: string;
}

type Env = (name: string) => string | undefined;

function denialStatus(reason: Authorization['reason']): number {
  switch (reason) {
    case 'upgrade_required':
      return 402;
    case 'daily_limit_reached':
      return 429;
    case 'unknown_model':
      return 400;
    default:
      return 503;
  }
}

/**
 * Chooses the ARO model, checks access (consuming one request) and builds
 * the endpoint list. Throws ProviderError with a user-facing message when
 * the request can't be served.
 */
export async function resolveAro(
  db: Db | null,
  userId: string,
  requested: string | undefined,
  messages: ChatMessage[],
  env: Env,
): Promise<AroResolution> {
  if (!db) {
    throw new ProviderError("ARO plans aren't set up on the server yet (Supabase database secrets are missing).", 503, false);
  }
  const images = hasImages(messages);
  const auto = !requested || requested === 'auto' || requested === 'aro';
  const route: Route = auto ? routeAroModel(messages, images) : { model: requested as AroModelId, reason: 'chosen' };
  if (!isAroModelId(route.model)) throw new ProviderError(`Unknown ARO model: ${requested}`, 400, false);

  if (images && route.model !== 'aro-vision') {
    throw new ProviderError(`${aroName(route.model)} can't read images. Pick ARO Vision (or Auto) to send images.`, 400, false);
  }
  if (route.model === 'aro-voice' || route.model === 'aro-creative') {
    throw new ProviderError(`${aroName(route.model)} isn't a chat model — it's used from its own screen.`, 400, false);
  }

  let aroModel: AroModelId = route.model;
  let notice: string | undefined;
  let auth = await authorize(db, userId, aroModel);

  // Auto never blocks the user: if the specialist isn't available to them,
  // ARO 1.5 answers and the app explains why.
  if (!auth.allowed && auto && aroModel !== 'aro-1.5' && !images) {
    notice = `${denialMessage(auth, aroName(aroModel))} ARO 1.5 answered instead.`;
    aroModel = 'aro-1.5';
    auth = await authorize(db, userId, aroModel);
  }
  if (!auth.allowed) {
    if (images && auth.reason === 'model_unavailable') {
      throw new ProviderError(
        "ARO Vision isn't available yet. To ask about an image, pick Claude, ChatGPT, Gemini or Qwen.",
        503,
        false,
      );
    }
    throw new ProviderError(denialMessage(auth, aroName(aroModel)), denialStatus(auth.reason), false);
  }

  const info = auth.model!;
  let endpoints: Endpoint[];
  try {
    endpoints = aroEndpoints(info.endpoint, info.served_name ?? aroModel, env);
  } catch (err) {
    await refund(db, userId, aroModel, auth.via); // nothing can answer: don't charge
    throw err;
  }
  return {
    aroModel,
    authorization: auth,
    endpoints,
    systemPrompt: info.system_prompt || ARO_SYSTEM_PROMPT,
    routed: auto,
    notice,
  };
}

/**
 * Endpoints to try, in order: the model on its server, then (for text
 * specialists) ARO 1.5 on the same server, then the backup model.
 */
export function aroEndpoints(kind: string, servedName: string, env: Env): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const key = env('ARO_MODEL_API_KEY')?.trim() || 'aro-no-key';
  const strip = (url: string) => url.replace(/\/+$/, '');

  if (kind === 'vision') {
    const url = env('ARO_VISION_BASE_URL')?.trim();
    if (url) {
      endpoints.push({
        provider: 'aro', kind: 'openai', baseUrl: strip(url), apiKey: env('ARO_VISION_API_KEY')?.trim() || key,
        model: servedName, servedBy: 'aro',
      });
    }
  } else {
    const url = env('ARO_MODEL_BASE_URL')?.trim();
    if (url) {
      endpoints.push({ provider: 'aro', kind: 'openai', baseUrl: strip(url), apiKey: key, model: servedName, servedBy: 'aro' });
      if (servedName !== 'aro-1.5') {
        endpoints.push({ provider: 'aro', kind: 'openai', baseUrl: strip(url), apiKey: key, model: 'aro-1.5', servedBy: 'aro' });
      }
    }
    const fallbackUrl = env('ARO_FALLBACK_BASE_URL')?.trim();
    const fallbackModel = env('ARO_FALLBACK_MODEL')?.trim();
    if (fallbackUrl && fallbackModel) {
      endpoints.push({
        provider: 'aro', kind: 'openai', baseUrl: strip(fallbackUrl),
        apiKey: env('ARO_FALLBACK_API_KEY')?.trim() || 'aro-no-key', model: fallbackModel, servedBy: 'fallback',
      });
    }
  }

  if (endpoints.length === 0) {
    throw new ProviderError('The ARO model server is offline right now. Please try again later or pick another model.', 503, false);
  }
  return endpoints;
}

/** Whether a failure may move on to the next endpoint. */
export function canTryNext(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  // The ARO server answers 404 for an adapter that isn't published yet.
  if (err.status === 404) return true;
  return err.retryable;
}
