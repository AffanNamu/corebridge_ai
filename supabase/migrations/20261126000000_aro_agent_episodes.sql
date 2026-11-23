-- Episodic memory for the coding agent: what went wrong in earlier runs on a
-- repository (declined actions and the user's reasons, commits held back by
-- review, loops, failed runs). The newest entries are shown to the agent at
-- the start of each run so it doesn't repeat the same mistakes.
--
-- Per user and repository only; never shared between users. Same security
-- model as the other ARO tables: RLS on, no policies, service_role only.

create table public.aro_agent_episodes (
  id         bigint generated always as identity primary key,
  user_id    text not null,
  repo       text not null,
  kind       text not null check (kind in ('declined', 'review', 'failed', 'loop')),
  lesson     text not null check (length(lesson) between 1 and 600),
  created_at timestamptz not null default now()
);
create index aro_agent_episodes_lookup on public.aro_agent_episodes (user_id, repo, created_at desc);
create index aro_agent_episodes_age on public.aro_agent_episodes (created_at);

alter table public.aro_agent_episodes enable row level security;
revoke all on table public.aro_agent_episodes from anon, authenticated;
grant all on table public.aro_agent_episodes to service_role;

-- Adds an entry; keeps the newest 50 per user and repository, and 90 days at most.
create or replace function public.aro_agent_episode_add(p_user text, p_repo text, p_kind text, p_lesson text)
returns void language plpgsql set search_path = public as $$
begin
  insert into aro_agent_episodes (user_id, repo, kind, lesson)
  values (p_user, p_repo, p_kind, left(p_lesson, 600));
  delete from aro_agent_episodes
   where user_id = p_user and repo = p_repo
     and id not in (select id from aro_agent_episodes where user_id = p_user and repo = p_repo order by created_at desc, id desc limit 50);
  if random() < 0.02 then
    delete from aro_agent_episodes where created_at < now() - interval '90 days';
  end if;
end $$;

-- The newest entries for one user and repository, newest first.
create or replace function public.aro_agent_episodes_recent(p_user text, p_repo text, p_limit integer default 8)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'lesson', lesson, 'created_at', created_at) order by created_at desc, id desc), '[]'::jsonb)
    from (select kind, lesson, created_at, id from aro_agent_episodes
           where user_id = p_user and repo = p_repo and created_at > now() - interval '90 days'
           order by created_at desc, id desc limit least(greatest(p_limit, 1), 20)) recent
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'aro_agent_episode_add(text, text, text, text)', 'aro_agent_episodes_recent(text, text, integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
