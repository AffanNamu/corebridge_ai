// aro-knowledge: the user's Knowledge Base and long-term memory.
//
// POST JSON { action, ... }:
//   kb_add      { title, text } or { filename, data (base64) }  → { id, chunks, embedded }
//   kb_list                                                     → { documents: [...] }
//   kb_delete   { id }
//   kb_search   { query }                                       → { passages: [...] }  (what chat would use)
//   memory_list                                                 → { enabled, memories: [...] }
//   memory_set  { enabled }
//   memory_add  { content }        (manual entry)
//   memory_delete { id } | memory_clear
//
// Everything is scoped to the signed-in user; the database functions are
// service_role only.

import type { Db } from '../_shared/db.ts';
import { dbFromEnv } from '../_shared/db.ts';
import { type DocKind, extract, kindFor } from '../_shared/extract.ts';
import type { VerifiedUser } from '../_shared/firebase-auth.ts';
import { CORS_HEADERS, errorResponse, jsonResponse } from '../_shared/http.ts';
import { chunkText, embedTexts, retrieve } from '../_shared/knowledge.ts';
import { kindOf } from '../_shared/memory.ts';

export interface KnowledgeDeps {
  verify: (req: Request) => Promise<VerifiedUser | null>;
  env?: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  db?: Db | null;
}

const MAX_TEXT_CHARS = 2_000_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fromBase64(data: string): Uint8Array {
  const bin = atob(data.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function handleRequest(req: Request, deps: KnowledgeDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);
  const user = await deps.verify(req);
  if (!user) return errorResponse('Unauthorized', 401);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const db = deps.db === undefined ? dbFromEnv(env) : deps.db;
  if (!db) return errorResponse("The Knowledge Base isn't set up on the server yet.", 503);
  const uid = user.uid;

  try {
    switch (body?.action) {
      case 'kb_add': {
        let text: string;
        let kind: DocKind;
        let title = typeof body.title === 'string' ? body.title.trim() : '';
        if (typeof body.data === 'string') {
          const filename = typeof body.filename === 'string' ? body.filename : '';
          const k = kindFor(filename);
          if (!k) return errorResponse('Unsupported file type. Use PDF, Word (.docx), text, Markdown, CSV, JSON or code files.', 400);
          const bytes = fromBase64(body.data);
          if (bytes.length > MAX_FILE_BYTES) return errorResponse('Files can be up to 10 MB.', 413);
          try {
            text = await extract(k, bytes);
          } catch (err) {
            return errorResponse((err as Error).message, 422);
          }
          kind = k;
          title ||= filename.replace(/\.[^.]+$/, '');
        } else if (typeof body.text === 'string') {
          text = body.text;
          kind = 'text';
        } else {
          return errorResponse('Send text, or a file as filename + data (base64).', 400);
        }
        if (text.length > MAX_TEXT_CHARS) return errorResponse('This document is too long (max 2 million characters).', 413);
        const chunks = chunkText(text);
        if (!chunks.length) return errorResponse('The document has no text.', 422);
        title = (title || chunks[0].split('\n')[0]).slice(0, 200) || 'Untitled';
        const vectors = await embedTexts(chunks, { env, fetchImpl: deps.fetchImpl });
        const result = await db.rpc<{ id?: string; chunks?: number; embedded?: boolean; error?: string }>('aro_kb_add', {
          p_user: uid, p_title: title, p_kind: kind, p_chars: text.length,
          p_chunks: chunks.map((content, i) => (vectors ? { content, embedding: JSON.stringify(vectors[i]) } : { content })),
        });
        if (result?.error) return errorResponse(result.error, 409);
        return jsonResponse({ ...result, title });
      }
      case 'kb_list':
        return jsonResponse({ documents: await db.rpc('aro_kb_list', { p_user: uid }) });
      case 'kb_delete':
        if (!UUID.test(body.id ?? '')) return errorResponse('Invalid document id', 400);
        return jsonResponse({ deleted: await db.rpc('aro_kb_delete', { p_user: uid, p_doc: body.id }) });
      case 'kb_search': {
        const query = typeof body.query === 'string' ? body.query.trim().slice(0, 2_000) : '';
        if (!query) return errorResponse('Send a query', 400);
        const found = await retrieve(db, uid, query, { env, fetchImpl: deps.fetchImpl });
        return jsonResponse({ documents: found.documents, passages: found.passages });
      }
      case 'memory_list':
        return jsonResponse(await db.rpc('aro_memory_list', { p_user: uid }));
      case 'memory_set':
        if (typeof body.enabled !== 'boolean') return errorResponse('enabled must be true or false', 400);
        return jsonResponse({ enabled: await db.rpc('aro_memory_set_enabled', { p_user: uid, p_enabled: body.enabled }) });
      case 'memory_add': {
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (content.length < 3 || content.length > 300) return errorResponse('A memory is 3 to 300 characters.', 400);
        const r = await db.rpc<{ saved: boolean; reason?: string }>('aro_memory_add', { p_user: uid, p_kind: kindOf(content), p_content: content, p_source: 'manual' });
        if (!r?.saved && r?.reason === 'disabled') return errorResponse('Turn memory on first.', 409);
        return jsonResponse(r);
      }
      case 'memory_delete':
        if (!UUID.test(body.id ?? '')) return errorResponse('Invalid memory id', 400);
        return jsonResponse({ deleted: await db.rpc('aro_memory_delete', { p_user: uid, p_id: body.id }) });
      case 'memory_clear':
        return jsonResponse({ deleted: await db.rpc('aro_memory_clear', { p_user: uid }) });
      default:
        return errorResponse('Unknown action', 400);
    }
  } catch (err) {
    console.error('aro-knowledge:', err);
    return errorResponse('Something went wrong. Try again shortly.', 502);
  }
}
