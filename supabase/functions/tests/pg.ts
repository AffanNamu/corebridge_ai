// Test helper: a real Postgres 16 (PGlite, in-process) with ARO's migrations
// applied, exposed through the same `Db` interface the Edge Functions use.

import { PGlite } from 'npm:@electric-sql/pglite@0.2.17';
import type { Db } from '../_shared/db.ts';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

export interface TestDb extends Db {
  pg: PGlite;
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

export async function testDb(): Promise<TestDb> {
  const pg = new PGlite();
  // Roles that Supabase provides.
  await pg.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin;');
  const files = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.endsWith('.sql')).sort();
  for (const file of files) {
    await pg.exec(Deno.readTextFileSync(new URL(file, MIGRATIONS)));
  }
  return {
    pg,
    async sql(query, params = []) {
      return (await pg.query(query, params)).rows as never;
    },
    async rpc(fn, args) {
      const names = Object.keys(args);
      const call = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
      const values = names.map((n) => {
        const v = args[n];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const rows = (await pg.query(call, values)).rows as { r: unknown }[];
      return rows[0]?.r as never;
    },
  };
}
