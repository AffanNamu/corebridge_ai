-- Knowledge and memory (agent reliability, phase 3):
--
--   * Knowledge Base: the user's own documents, split into passages, searched
--     with keywords (any language: 'simple' text search + trigrams) and, when
--     an embedding model is configured, bge-m3 vectors. Chat answers from them
--     with citations; "only my documents" mode refuses to answer without them.
--   * Long-term memory: facts and preferences the user chose to let ARO keep.
--     OFF by default; the user can see, add and delete every entry.
--   * Conversation summaries: when a long chat no longer fits ARO's context,
--     older messages are condensed once and the summary is reused.
--
-- Everything is per user. Same security model as the other ARO tables:
-- RLS on, no policies, and the functions are executable by service_role only.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm;

-- An OR prefix query from words the caller already split (JSON array of strings),
-- or null. Each word is quoted, so nothing in it is read as query syntax.
create or replace function public.aro_terms_query(p_terms jsonb)
returns tsquery language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_terms) = 'array' and jsonb_array_length(p_terms) > 0
    then to_tsquery('simple', array_to_string(array(
      select quote_literal(left(t, 60)) || ':*' from jsonb_array_elements_text(p_terms) t where length(t) > 0 limit 16), ' | '))
  end
$$;

-- ------------------------------------------------------------ knowledge base

create table public.aro_kb_documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  title       text not null check (length(title) between 1 and 200),
  kind        text not null default 'text' check (kind in ('text', 'markdown', 'pdf', 'docx', 'code', 'csv', 'json')),
  chars       integer not null check (chars >= 0),
  chunk_count integer not null check (chunk_count >= 0),
  embedded    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index aro_kb_documents_user on public.aro_kb_documents (user_id, created_at desc);

create table public.aro_kb_chunks (
  id        bigint generated always as identity primary key,
  doc_id    uuid not null references public.aro_kb_documents (id) on delete cascade,
  user_id   text not null,
  ord       integer not null,
  content   text not null check (length(content) between 1 and 4000),
  tsv       tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding extensions.vector(1024)
);
create index aro_kb_chunks_user on public.aro_kb_chunks (user_id, doc_id, ord);
create index aro_kb_chunks_tsv on public.aro_kb_chunks using gin (tsv);
create index aro_kb_chunks_trgm on public.aro_kb_chunks using gin (content gin_trgm_ops);
create index aro_kb_chunks_embedding on public.aro_kb_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.aro_kb_documents enable row level security;
alter table public.aro_kb_chunks enable row level security;
revoke all on table public.aro_kb_documents, public.aro_kb_chunks from anon, authenticated;
grant all on table public.aro_kb_documents, public.aro_kb_chunks to service_role;

-- Adds a document and its passages (p_chunks: [{content, embedding?: number[]}]).
-- Limits: 200 documents, 20 million characters and 20,000 passages per user.
create or replace function public.aro_kb_add(p_user text, p_title text, p_kind text, p_chars integer, p_chunks jsonb)
returns jsonb language plpgsql set search_path = public, extensions as $$
declare
  v_id uuid;
  v_count integer := jsonb_array_length(p_chunks);
  v_docs integer;
  v_chars bigint;
  v_chunks bigint;
  v_embedded boolean := coalesce((select bool_and(c ? 'embedding') from jsonb_array_elements(p_chunks) c), false);
begin
  if v_count = 0 then return jsonb_build_object('error', 'The document has no text.'); end if;
  select count(*), coalesce(sum(chars), 0), coalesce(sum(chunk_count), 0) into v_docs, v_chars, v_chunks
    from aro_kb_documents where user_id = p_user;
  if v_docs >= 200 then return jsonb_build_object('error', 'Your Knowledge Base is full (200 documents). Delete some first.'); end if;
  if v_chars + p_chars > 20000000 or v_chunks + v_count > 20000 then
    return jsonb_build_object('error', 'Your Knowledge Base is full. Delete some documents first.');
  end if;
  insert into aro_kb_documents (user_id, title, kind, chars, chunk_count, embedded)
  values (p_user, left(p_title, 200), p_kind, p_chars, v_count, v_embedded)
  returning id into v_id;
  insert into aro_kb_chunks (doc_id, user_id, ord, content, embedding)
  select v_id, p_user, (c.ord - 1)::integer, c.value->>'content',
         case when c.value ? 'embedding' then (c.value->>'embedding')::vector(1024) end
    from jsonb_array_elements(p_chunks) with ordinality as c(value, ord);
  return jsonb_build_object('id', v_id, 'chunks', v_count, 'embedded', v_embedded);
end $$;

create or replace function public.aro_kb_list(p_user text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'title', title, 'kind', kind, 'chars', chars, 'chunks', chunk_count, 'embedded', embedded, 'created_at', created_at
  ) order by created_at desc), '[]'::jsonb)
  from aro_kb_documents where user_id = p_user
$$;

create or replace function public.aro_kb_delete(p_user text, p_doc uuid)
returns boolean language plpgsql set search_path = public as $$
begin
  delete from aro_kb_documents where user_id = p_user and id = p_doc;
  return found;
end $$;

-- How many documents the user has (0 = skip retrieval), and how many have vectors.
create or replace function public.aro_kb_stats(p_user text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('documents', count(*), 'embedded', count(*) filter (where embedded))
    from aro_kb_documents where user_id = p_user
$$;

-- Hybrid search over the user's passages. p_terms: the query's words (already
-- lower-cased and split by the caller, so every script works); p_embedding: the
-- query vector as text '[…]', or null. Candidates from keywords, trigrams and
-- vectors are fused with reciprocal-rank fusion; the caller applies the
-- confidence threshold.
create or replace function public.aro_kb_search(
  p_user text, p_query text, p_terms jsonb, p_embedding text default null, p_docs jsonb default null, p_limit integer default 12)
returns jsonb language plpgsql stable set search_path = public, extensions as $$
declare
  q tsquery;
  v vector(1024);
  docs uuid[] := case when jsonb_typeof(p_docs) = 'array' then array(select jsonb_array_elements_text(p_docs)::uuid) end;
begin
  q := aro_terms_query(p_terms);
  if p_embedding is not null then v := p_embedding::vector(1024); end if;
  return coalesce((
    with mine as (
      select c.id, c.doc_id, c.ord, c.content, c.tsv, c.embedding
        from aro_kb_chunks c
       where c.user_id = p_user and (docs is null or c.doc_id = any (docs))
    ),
    lex as (
      select id, row_number() over (order by ts_rank_cd(tsv, q, 32) desc, id) as r
        from mine where q is not null and tsv @@ q
       order by r limit 30
    ),
    tri as (
      select id, row_number() over (order by word_similarity(p_query, content) desc, id) as r
        from mine where length(p_query) >= 3 and p_query <% content
       order by r limit 30
    ),
    vec as (
      select id, row_number() over (order by embedding <=> v, id) as r, 1 - (embedding <=> v) as cosine
        from mine where v is not null and embedding is not null
       order by embedding <=> v limit 30
    ),
    fused as (
      select id, sum(1.0 / (60 + r)) as score, max(cosine) as cosine
        from (select id, r, null::float8 as cosine from lex
              union all select id, r, null from tri
              union all select id, r, cosine from vec) all_hits
       group by id
    )
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'doc_id', m.doc_id, 'title', d.title, 'ord', m.ord, 'content', m.content,
      'score', f.score, 'cosine', f.cosine
    ) order by f.score desc, m.id)
    from (select * from fused order by score desc, id limit least(greatest(p_limit, 1), 30)) f
    join mine m on m.id = f.id
    join aro_kb_documents d on d.id = m.doc_id
  ), '[]'::jsonb);
end $$;

-- ------------------------------------------------------------ long-term memory

create table public.aro_memory_settings (
  user_id    text primary key,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.aro_memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  kind       text not null check (kind in ('preference', 'fact', 'rule')),
  content    text not null check (length(content) between 1 and 300),
  source     text not null default 'auto' check (source in ('auto', 'explicit', 'manual')),
  tsv        tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at timestamptz not null default now()
);
create index aro_memories_user on public.aro_memories (user_id, created_at desc);
create index aro_memories_tsv on public.aro_memories using gin (tsv);

alter table public.aro_memory_settings enable row level security;
alter table public.aro_memories enable row level security;
revoke all on table public.aro_memory_settings, public.aro_memories from anon, authenticated;
grant all on table public.aro_memory_settings, public.aro_memories to service_role;

create or replace function public.aro_memory_set_enabled(p_user text, p_enabled boolean)
returns boolean language sql set search_path = public as $$
  insert into aro_memory_settings (user_id, enabled) values (p_user, p_enabled)
  on conflict (user_id) do update set enabled = excluded.enabled, updated_at = now()
  returning enabled
$$;

-- Saves a memory unless memory is off or a near-duplicate exists. At most 200 per user (oldest dropped).
create or replace function public.aro_memory_add(p_user text, p_kind text, p_content text, p_source text default 'auto')
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id uuid;
  v_dup uuid;
begin
  if not coalesce((select enabled from aro_memory_settings where user_id = p_user), false) then
    return jsonb_build_object('saved', false, 'reason', 'disabled');
  end if;
  select id into v_dup from aro_memories
   where user_id = p_user and similarity(lower(content), lower(p_content)) > 0.7 limit 1;
  if v_dup is not null then return jsonb_build_object('saved', false, 'reason', 'duplicate', 'id', v_dup); end if;
  insert into aro_memories (user_id, kind, content, source) values (p_user, p_kind, left(trim(p_content), 300), p_source)
  returning id into v_id;
  delete from aro_memories where user_id = p_user and id not in (
    select id from aro_memories where user_id = p_user order by created_at desc, id limit 200);
  return jsonb_build_object('saved', true, 'id', v_id);
end $$;

create or replace function public.aro_memory_list(p_user text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'enabled', coalesce((select enabled from aro_memory_settings where user_id = p_user), false),
    'memories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'content', content, 'source', source, 'created_at', created_at)
                                             order by created_at desc) from aro_memories where user_id = p_user), '[]'::jsonb))
$$;

create or replace function public.aro_memory_delete(p_user text, p_id uuid)
returns boolean language plpgsql set search_path = public as $$
begin
  delete from aro_memories where user_id = p_user and id = p_id;
  return found;
end $$;

create or replace function public.aro_memory_clear(p_user text)
returns integer language plpgsql set search_path = public as $$
declare n integer;
begin
  delete from aro_memories where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;

-- Deletes the memories that match what the user asked to forget. Returns what was removed.
create or replace function public.aro_memory_forget(p_user text, p_text text)
returns jsonb language plpgsql set search_path = public as $$
declare removed jsonb;
begin
  with gone as (
    delete from aro_memories
     where user_id = p_user and (word_similarity(lower(p_text), lower(content)) > 0.6 or similarity(lower(content), lower(p_text)) > 0.4)
    returning content
  )
  select coalesce(jsonb_agg(content), '[]'::jsonb) into removed from gone;
  return removed;
end $$;

-- What to put in the prompt: nothing when memory is off; otherwise the newest
-- rules and preferences plus the entries that match this message.
create or replace function public.aro_memory_context(p_user text, p_terms jsonb, p_limit integer default 8)
returns jsonb language plpgsql stable set search_path = public as $$
declare q tsquery;
begin
  if not coalesce((select enabled from aro_memory_settings where user_id = p_user), false) then
    return jsonb_build_object('enabled', false, 'memories', '[]'::jsonb);
  end if;
  q := aro_terms_query(p_terms);
  return jsonb_build_object('enabled', true, 'memories', coalesce((
    select jsonb_agg(content order by rank desc, created_at desc) from (
      select content, created_at,
             case when q is not null and tsv @@ q then 2 + ts_rank_cd(tsv, q) when kind in ('rule', 'preference') then 1 else 0 end as rank
        from aro_memories where user_id = p_user
       order by rank desc, created_at desc limit least(greatest(p_limit, 1), 20)
    ) picked where rank > 0
  ), '[]'::jsonb));
end $$;

-- ------------------------------------------------------- conversation summaries

create table public.aro_conversation_summaries (
  user_id     text not null,
  prefix_hash text not null,
  covered     integer not null check (covered > 0),
  summary     text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, prefix_hash)
);
create index aro_conversation_summaries_age on public.aro_conversation_summaries (created_at);
alter table public.aro_conversation_summaries enable row level security;
revoke all on table public.aro_conversation_summaries from anon, authenticated;
grant all on table public.aro_conversation_summaries to service_role;

-- The summary covering the longest of the given conversation prefixes, or null.
create or replace function public.aro_summary_lookup(p_user text, p_hashes jsonb)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('hash', prefix_hash, 'covered', covered, 'summary', summary)
    from aro_conversation_summaries
   where user_id = p_user and prefix_hash in (select jsonb_array_elements_text(p_hashes))
   order by covered desc limit 1
$$;

create or replace function public.aro_summary_save(p_user text, p_hash text, p_covered integer, p_summary text)
returns void language plpgsql set search_path = public as $$
begin
  insert into aro_conversation_summaries (user_id, prefix_hash, covered, summary)
  values (p_user, p_hash, p_covered, left(p_summary, 6000))
  on conflict (user_id, prefix_hash) do nothing;
  -- Summaries hold conversation content: keep 30 days.
  if random() < 0.02 then
    delete from aro_conversation_summaries where created_at < now() - interval '30 days';
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'aro_kb_add(text, text, text, integer, jsonb)', 'aro_kb_list(text)', 'aro_kb_delete(text, uuid)', 'aro_kb_stats(text)',
    'aro_kb_search(text, text, jsonb, text, jsonb, integer)', 'aro_terms_query(jsonb)',
    'aro_memory_set_enabled(text, boolean)', 'aro_memory_add(text, text, text, text)', 'aro_memory_list(text)',
    'aro_memory_delete(text, uuid)', 'aro_memory_clear(text)', 'aro_memory_forget(text, text)', 'aro_memory_context(text, jsonb, integer)',
    'aro_summary_lookup(text, jsonb)', 'aro_summary_save(text, text, integer, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
