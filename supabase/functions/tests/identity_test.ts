// ARO is one model family by ARO Group: after all migrations, the database's
// capability rows match models/catalog.json, and nothing presents a capability
// as a separate product.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { aroName, ARO_MODEL_IDS } from '../_shared/aro.ts';
import { testDb } from './pg.ts';

const catalog = JSON.parse(Deno.readTextFileSync(new URL('../../../models/catalog.json', import.meta.url)));

Deno.test({ name: 'database capabilities match the catalogue (names, prompts, generation, capability)', sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const db = await testDb();
  const rows = await db.sql<any>('select id, name, tagline, generation, capability, system_prompt from aro_models order by sort');
  assertEquals(rows.map((r) => r.id), catalog.models.map((m: any) => m.id));
  for (const m of catalog.models) {
    const row = rows.find((r) => r.id === m.id);
    assertEquals([row.name, row.tagline, row.generation, row.capability], [m.name, m.tagline, m.generation, m.capability], m.id);
    if (m.system_prompt) assertEquals(row.system_prompt, m.system_prompt, m.id);
    assertEquals(aroName(m.id), m.name, `aro.ts display name for ${m.id}`);
  }
  const products = await db.sql<any>('select name from aro_model_products order by id');
  assert(products.every((p) => p.name.startsWith('ARO 1.5 · ')), JSON.stringify(products));
} });

Deno.test('one family: every prompt says ARO and ARO Group; ARO 1.5 capabilities say ARO 1.5; no "ARO Code"-style product names', () => {
  assertEquals(catalog.family.developer, 'ARO Group');
  assertEquals(catalog.family.current_generation, 'aro-1.5');
  const current = catalog.generations.find((g: any) => g.id === 'aro-1.5');
  assertEquals(current.status, 'current');
  for (const g of catalog.generations.filter((g: any) => g.id !== 'aro-1.5')) {
    assertEquals(g.status, 'planned', `${g.id} must not claim to be available`);
  }
  for (const m of catalog.models) {
    assert(ARO_MODEL_IDS.includes(m.id));
    assert(!/^ARO (Code|Research|Vision|Voice|Creative|Translate)\b/.test(m.name), m.name);
    if (!m.system_prompt) continue;
    assert(m.system_prompt.includes('ARO Group'), m.id);
    if (m.generation === 'aro-1.5') assert(m.system_prompt.includes('Your model is ARO 1.5'), m.id);
    assert(!/You are ARO (Code|Research|Vision|Translate)\b/.test(m.system_prompt), m.id);
  }
  // Capabilities that no released generation has must not be attributed to one.
  for (const id of ['aro-vision', 'aro-voice', 'aro-creative']) {
    assertEquals(catalog.models.find((m: any) => m.id === id).generation, null, id);
  }
});
