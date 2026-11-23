-- Episodic log: also record commits held back because the repository's tests
-- failed in the sandbox (agent reliability, phase 4).
alter table public.aro_agent_episodes drop constraint if exists aro_agent_episodes_kind_check;
alter table public.aro_agent_episodes add constraint aro_agent_episodes_kind_check
  check (kind in ('declined', 'review', 'failed', 'loop', 'tests'));
