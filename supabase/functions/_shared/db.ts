// Database access for Edge Functions: only Postgres functions (RPC) defined
// in supabase/migrations, called with the service-role key. Tests swap in
// an in-process Postgres (PGlite) running the very same SQL.

import { shortError } from './http.ts';

export interface Db {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
}

export class DbError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DbError';
  }
}

/** Calls Postgres functions through Supabase's PostgREST API. */
export class PostgrestDb implements Db {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch { /* not JSON */ }
      throw new DbError(`Database error (${response.status}): ${shortError(message, 300)}`, response.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** The service-role database, or null when the secrets aren't set. */
export function dbFromEnv(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): Db | null {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return url && key ? new PostgrestDb(url, key) : null;
}
