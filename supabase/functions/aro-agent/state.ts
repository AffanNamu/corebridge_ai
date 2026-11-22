// Agent session state. The app stores it (Firestore agentSessions doc) and
// sends it back with every request, so the Edge Function stays stateless
// and a long task can continue across several requests.

import type { AgentMessage } from '../_shared/llm/tool_chat.ts';

export type PushMode = 'branch' | 'direct';

export interface AgentState {
  version: 1;
  repo: { owner: string; name: string };
  baseBranch: string;
  workBranch: string;
  pushMode: PushMode;
  branchCreated: boolean;
  transcript: AgentMessage[];
  /** Staged, not yet committed edits: path → new content, or null to delete. */
  pending: Record<string, string | null>;
  commits: { sha: string; url: string; message: string; files: string[] }[];
  pullRequest?: { number: number; url: string };
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}(?<!\/)$/;

export function isValidRepoName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value) && value !== '.' && value !== '..';
}

export function isValidBranch(value: unknown): value is string {
  return typeof value === 'string' && BRANCH.test(value);
}

/** Branch name the agent works on when it may not push to the base branch. */
export function newWorkBranch(task: string, now = Date.now()): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'task';
  return `aro/${slug}-${now.toString(36).slice(-5)}`;
}

export function createState(
  owner: string,
  name: string,
  baseBranch: string,
  pushMode: PushMode,
  firstTask: string,
): AgentState {
  return {
    version: 1,
    repo: { owner, name },
    baseBranch,
    workBranch: pushMode === 'direct' ? baseBranch : newWorkBranch(firstTask),
    pushMode,
    branchCreated: pushMode === 'direct',
    transcript: [],
    pending: {},
    commits: [],
  };
}

/** Validates state sent back by the app. Returns an error message or the state. */
export function parseState(raw: unknown): AgentState | string {
  const s = raw as AgentState;
  if (!s || typeof s !== 'object' || s.version !== 1) return 'Invalid agent state';
  if (!isValidRepoName(s.repo?.owner) || !isValidRepoName(s.repo?.name)) return 'Invalid repository in state';
  if (!isValidBranch(s.baseBranch) || !isValidBranch(s.workBranch)) return 'Invalid branch in state';
  if (s.pushMode !== 'branch' && s.pushMode !== 'direct') return 'Invalid push mode';
  if (s.pushMode === 'branch' && s.workBranch === s.baseBranch) return 'Invalid working branch';
  if (!Array.isArray(s.transcript) || !Array.isArray(s.commits)) return 'Invalid agent state';
  if (!s.pending || typeof s.pending !== 'object') return 'Invalid agent state';
  return { ...s, branchCreated: s.branchCreated === true };
}

const KEEP_FULL = 6;
const OLD_RESULT_CHARS = 1_500;
const MAX_TRANSCRIPT_CHARS = 250_000;

/**
 * Shortens old tool results so long sessions stay within model context and
 * Firestore's 1 MB document limit. Recent messages are kept in full.
 */
export function compactTranscript(transcript: AgentMessage[]): AgentMessage[] {
  const compacted = transcript.map((message, index) => {
    if (message.role !== 'tool' || index >= transcript.length - KEEP_FULL) return message;
    return {
      role: 'tool' as const,
      results: message.results.map((r) =>
        r.content.length > OLD_RESULT_CHARS
          ? { ...r, content: `${r.content.slice(0, OLD_RESULT_CHARS)}\n… (older output shortened — re-run the tool if needed)` }
          : r
      ),
    };
  });

  // Still too large: drop the oldest exchanges but keep the first task.
  let size = JSON.stringify(compacted).length;
  while (size > MAX_TRANSCRIPT_CHARS && compacted.length > KEEP_FULL + 1) {
    const removed = compacted.splice(1, 1);
    size -= JSON.stringify(removed).length;
    // Never leave tool results without the assistant call that produced them.
    while (compacted.length > 1 && compacted[1].role === 'tool') {
      size -= JSON.stringify(compacted.splice(1, 1)).length;
    }
  }
  return compacted;
}
