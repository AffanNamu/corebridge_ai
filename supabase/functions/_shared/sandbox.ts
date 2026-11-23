// Real code execution for the coding agent: commands run in an isolated
// RunPod Serverless CPU worker (infra/sandbox/handler.py) — one job per
// container, an unprivileged user, no credentials, a time limit, and the
// worker restarted after every job.
//
// Config: SANDBOX_URL (e.g. https://api.runpod.ai/v2/<endpoint-id>) and
// SANDBOX_API_KEY (falls back to ARO_MODEL_API_KEY, the RunPod key ARO uses).
// Without SANDBOX_URL the agent's sandbox tools are not offered.

export interface SandboxInput {
  mode: 'repo' | 'python';
  repo_url?: string;
  files?: Record<string, string | null>;
  command?: string;
  code?: string;
  toolchains?: ('node' | 'go')[];
  timeout_seconds: number;
}

export interface SandboxResult {
  exit_code: number;
  timed_out: boolean;
  output: string;
  duration_ms: number;
  setup?: string;
}

export type SandboxOutcome =
  | { state: 'done'; result: SandboxResult; jobId: string }
  | { state: 'running'; jobId: string };

export interface SandboxDeps {
  env: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SandboxError extends Error {}

const TERMINAL_FAIL = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT']);
const JOB_ID = /^[A-Za-z0-9-]{8,80}$/;

export function sandboxConfigured(env: (name: string) => string | undefined): boolean {
  return !!env('SANDBOX_URL')?.trim();
}

function config(deps: SandboxDeps) {
  const base = deps.env('SANDBOX_URL')?.trim().replace(/\/+$/, '');
  if (!base) throw new SandboxError('Code execution is not set up on this server.');
  const key = deps.env('SANDBOX_API_KEY')?.trim() || deps.env('ARO_MODEL_API_KEY')?.trim() || '';
  return { base, headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` } };
}

export function isJobId(id: unknown): id is string {
  return typeof id === 'string' && JOB_ID.test(id);
}

async function poll(jobId: string, deps: SandboxDeps, waitMs: number): Promise<SandboxOutcome> {
  const { base, headers } = config(deps);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const until = now() + Math.max(0, waitMs);
  for (;;) {
    const res = await (deps.fetchImpl ?? fetch)(`${base}/status/${jobId}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new SandboxError(`The sandbox didn't answer (${res.status}).`);
    const data = await res.json();
    if (data.status === 'COMPLETED') {
      const out = data.output ?? {};
      if (out.error) throw new SandboxError(String(out.error).slice(0, 500));
      return { state: 'done', jobId, result: out as SandboxResult };
    }
    if (TERMINAL_FAIL.has(data.status)) {
      throw new SandboxError(`The sandbox job ${String(data.status).toLowerCase().replace('_', ' ')}${data.error ? `: ${String(data.error).slice(0, 300)}` : ''}.`);
    }
    if (now() >= until) return { state: 'running', jobId };
    await sleep(Math.min(2_000, Math.max(250, until - now())));
  }
}

/** Submits a job and waits up to `waitMs` for it (then returns its id so it can be collected later). */
export async function runSandbox(input: SandboxInput, deps: SandboxDeps, waitMs: number): Promise<SandboxOutcome> {
  const { base, headers } = config(deps);
  const res = await (deps.fetchImpl ?? fetch)(`${base}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input, policy: { executionTimeout: (input.timeout_seconds + 240) * 1000, ttl: 3_600_000 } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new SandboxError(`The sandbox couldn't start the job (${res.status}).`);
  const { id } = await res.json();
  if (!isJobId(id)) throw new SandboxError('The sandbox returned no job id.');
  return await poll(id, deps, waitMs);
}

export async function sandboxResult(jobId: string, deps: SandboxDeps, waitMs: number): Promise<SandboxOutcome> {
  return await poll(jobId, deps, waitMs);
}

export function formatResult(result: SandboxResult, what: string): string {
  const secs = (result.duration_ms / 1000).toFixed(1);
  const head = result.timed_out
    ? `${what} timed out after ${secs}s and was stopped.`
    : `${what} finished with exit code ${result.exit_code} in ${secs}s${result.exit_code === 0 ? ' (success)' : ' (failed)'}.`;
  return `${head}${result.setup ? ` Installed: ${result.setup}.` : ''}\n--- output ---\n${result.output || '(no output)'}`;
}

/** Which toolchains a shell command needs beyond the image's Python, git and C compiler. */
export function toolchainsFor(command: string): ('node' | 'go')[] {
  const out: ('node' | 'go')[] = [];
  if (/\b(npm|npx|node|yarn|pnpm|corepack|tsc|jest|vitest|eslint)\b/.test(command)) out.push('node');
  if (/(^|[\s;&|(])go\s+(test|build|run|vet|mod)\b/.test(command)) out.push('go');
  return out;
}
