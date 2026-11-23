-- Coding agent checkpoints: the agent's state is saved after every tool call,
-- so a timeout or API error mid-run doesn't lose the work done so far. The
-- app keeps its own copy too; on resume the newer of the two wins.
--
-- Same security model as the other ARO tables: RLS on, no policies, and the
-- functions are executable by service_role only.

create table public.aro_agent_checkpoints (
  user_id    text not null,
  session_id uuid not null,
  checkpoint integer not null check (checkpoint >= 0),
  status     text not null check (status in ('running', 'awaiting_confirmation', 'paused', 'completed', 'failed')),
  repo       text not null,
  state      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, session_id)
);
create index aro_agent_checkpoints_updated on public.aro_agent_checkpoints (updated_at);

alter table public.aro_agent_checkpoints enable row level security;
revoke all on table public.aro_agent_checkpoints from anon, authenticated;
grant all on table public.aro_agent_checkpoints to service_role;

-- Saves a checkpoint; an older checkpoint never overwrites a newer one.
create or replace function public.aro_agent_checkpoint(
  p_user text, p_session uuid, p_checkpoint integer, p_status text, p_repo text, p_state jsonb)
returns void language plpgsql set search_path = public as $$
begin
  insert into aro_agent_checkpoints (user_id, session_id, checkpoint, status, repo, state)
  values (p_user, p_session, p_checkpoint, p_status, p_repo, p_state)
  on conflict (user_id, session_id) do update set
    checkpoint = excluded.checkpoint, status = excluded.status, repo = excluded.repo,
    state = excluded.state, updated_at = now()
  where aro_agent_checkpoints.checkpoint <= excluded.checkpoint;
  -- Agent sessions hold repository content: keep 30 days.
  if random() < 0.02 then
    delete from aro_agent_checkpoints where updated_at < now() - interval '30 days';
  end if;
end $$;

-- The latest checkpoint of one of the user's sessions, or null.
create or replace function public.aro_agent_load(p_user text, p_session uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('checkpoint', checkpoint, 'status', status, 'repo', repo, 'state', state, 'updated_at', updated_at)
    from aro_agent_checkpoints where user_id = p_user and session_id = p_session
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'aro_agent_checkpoint(text, uuid, integer, text, text, jsonb)', 'aro_agent_load(text, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
