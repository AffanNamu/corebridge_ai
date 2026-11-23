// The agent's plan: written after exploring and before the first change,
// shown to the user, kept up to date as steps finish, and repeated in the
// system prompt every turn so it survives transcript compaction.

import type { ToolDefinition } from '../_shared/llm/tool_chat.ts';

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface Plan {
  goal: string;
  steps: { title: string; status: StepStatus }[];
}

export const MAX_PLAN_STEPS = 12;

export const PLAN_TOOL: ToolDefinition = {
  name: 'set_plan',
  description:
    'Record your plan, or update it. Call it after exploring and BEFORE your first change (write_file, edit_file, ' +
    'delete_file, commit_and_push, create_pull_request). Send the whole plan each time, marking steps done as you go. ' +
    'Keep it short: concrete steps such as "Fix the null check in src/auth.ts", "Add a test", "Commit and open a PR".',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: 300 },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PLAN_STEPS,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'] },
          },
          required: ['title', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['goal', 'steps'],
    additionalProperties: false,
  },
};

/** Tools that change the repository or notify people: they need a plan first. */
export const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'commit_and_push', 'create_pull_request']);

/** After this many refusals for a missing plan, a minimal plan is made from the task so the run never stalls. */
export const MAX_PLAN_REFUSALS = 2;

export function planFromArgs(args: Record<string, unknown>): Plan {
  const steps = (args.steps as { title: string; status: StepStatus }[]).map((s) => ({ title: s.title.trim(), status: s.status }));
  return { goal: String(args.goal).trim(), steps };
}

export function fallbackPlan(task: string): Plan {
  return {
    goal: task.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Complete the requested change',
    steps: [
      { title: 'Make the requested change', status: 'in_progress' },
      { title: 'Review and commit', status: 'pending' },
    ],
  };
}

const MARK: Record<StepStatus, string> = { pending: '[ ]', in_progress: '[~]', done: '[x]', skipped: '[-]' };

export function formatPlan(plan: Plan): string {
  return [`Goal: ${plan.goal}`, ...plan.steps.map((s, i) => `${MARK[s.status]} ${i + 1}. ${s.title}`)].join('\n');
}

export function parsePlan(raw: unknown): Plan | undefined {
  const p = raw as Plan;
  if (!p || typeof p.goal !== 'string' || !Array.isArray(p.steps)) return undefined;
  const steps = p.steps
    .filter((s) => s && typeof s.title === 'string' && ['pending', 'in_progress', 'done', 'skipped'].includes(s.status))
    .slice(0, MAX_PLAN_STEPS)
    .map((s) => ({ title: s.title.slice(0, 200), status: s.status }));
  return steps.length ? { goal: p.goal.slice(0, 300), steps } : undefined;
}
