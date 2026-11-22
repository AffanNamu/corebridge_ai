// Paid-access checks. All decisions are made in Postgres (aro_authorize) so
// they can't be bypassed from the app and concurrent requests can't race.

import type { Db } from './db.ts';

export interface ModelInfo {
  id: string;
  name: string;
  status: 'live' | 'preview' | 'planned' | 'disabled';
  served_name: string | null;
  endpoint: 'text' | 'vision' | 'voice' | 'creative';
  system_prompt: string;
  credit_cost: number;
}

export interface Authorization {
  allowed: boolean;
  via?: 'plan' | 'purchase' | 'credits';
  reason?: 'unknown_model' | 'model_unavailable' | 'daily_limit_reached' | 'upgrade_required';
  plan?: string;
  limit?: number | null;
  used?: number;
  remaining?: number | null;
  credits?: number;
  upgrade_plans?: string[];
  model?: ModelInfo;
}

export function authorize(db: Db, userId: string, modelId: string, consume = true): Promise<Authorization> {
  return db.rpc<Authorization>('aro_authorize', { p_user: userId, p_model: modelId, p_consume: consume });
}

/** Gives a request back when the model failed before producing any output. */
export async function refund(db: Db, userId: string, modelId: string, via: string | undefined): Promise<void> {
  await db.rpc('aro_refund', { p_user: userId, p_model: modelId, p_via: via ?? 'plan' });
}

export function overview(db: Db, userId: string): Promise<Record<string, unknown>> {
  return db.rpc('aro_user_overview', { p_user: userId });
}

const PLAN_NAMES: Record<string, string> = { free: 'Free', pro: 'Pro', premium: 'Premium' };

function planList(ids: string[] = []): string {
  const names = ids.map((id) => PLAN_NAMES[id] ?? id);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A message the app can show as-is when access is denied. */
export function denialMessage(result: Authorization, modelName: string): string {
  const plan = PLAN_NAMES[result.plan ?? 'free'] ?? result.plan;
  const credits = (result.model?.credit_cost ?? 0) > 0;
  switch (result.reason) {
    case 'model_unavailable':
      return `${modelName} isn't available yet. Pick another model for now.`;
    case 'daily_limit_reached':
      return `You've used all ${result.limit} ${modelName} requests for today on ${plan}. ` +
        'They reset at midnight UTC' +
        (result.upgrade_plans?.length ? `, or upgrade to ${planList(result.upgrade_plans)} for more.` : '.') +
        (credits ? ' You can also use credits.' : '');
    case 'upgrade_required':
      return `${modelName} isn't included in ${plan}.` +
        (result.upgrade_plans?.length ? ` It's included in ${planList(result.upgrade_plans)}.` : '') +
        (credits ? ' You can also buy it separately or use credits.' : '');
    default:
      return `${modelName} is not available.`;
  }
}

/** Admins are listed by Firebase uid in the ADMIN_UIDS secret (comma-separated). */
export function isAdmin(uid: string, env: (name: string) => string | undefined = (n) => Deno.env.get(n)): boolean {
  return (env('ADMIN_UIDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(uid);
}
