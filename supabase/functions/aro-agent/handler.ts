// aro-agent: ARO AI's GitHub coding agent. The user connects a repo with
// their own GitHub token; the agent reads the code, makes changes and
// pushes them as commits (to a working branch, or straight to the base
// branch if the user turned that on), and can open a pull request.
//
// Request body (POST, JSON):
//   {
//     provider, model?, apiKey?,         // which model drives the agent
//     githubToken,                       // user's fine-grained PAT
//     repo: { owner, name }, baseBranch?, pushMode?: 'branch' | 'direct',
//     message?: string,                  // the user's instruction
//     continue?: boolean,                // resume a paused run
//     state?: AgentState                 // returned by the previous response
//   }
//
// Response: SSE frames, each `data: {...}` with a `type`:
//   status | text | tool | tool_result | commit | pull_request | error
//   then `state` (save it and send it back next time), then `done`.

import { type AroResolution, canTryNext, resolveAro } from '../_shared/aro.ts';
import { type Db, dbFromEnv } from '../_shared/db.ts';
import { refund } from '../_shared/entitlements.ts';
import type { VerifiedUser } from '../_shared/firebase-auth.ts';
import { GitHubClient, GitHubError } from '../_shared/github.ts';
import { CORS_HEADERS, errorResponse, SSE_DONE, SSE_HEADERS, sseFrame } from '../_shared/http.ts';
import { resolveEndpoints } from '../_shared/llm/providers.ts';
import { type AgentMessage, chatWithTools, type ToolCall } from '../_shared/llm/tool_chat.ts';
import { type Endpoint, isProviderId, ProviderError } from '../_shared/llm/types.ts';
import {
  type AgentState,
  compactTranscript,
  createState,
  isValidBranch,
  isValidRepoName,
  parseState,
  type PushMode,
} from './state.ts';
import { TOOL_DEFINITIONS, ToolRunner } from './tools.ts';

export interface AgentDeps {
  verify: (req: Request) => Promise<VerifiedUser | null>;
  env?: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Entitlements database. Undefined = from env; null = not configured. */
  db?: Db | null;
}

const MAX_STEPS_PER_REQUEST = 25;
const DEFAULT_TIME_BUDGET_MS = 110_000; // Edge Functions stop at 150 s.
const MAX_MESSAGE_CHARS = 20_000;

export function systemPrompt(state: AgentState): string {
  const push = state.pushMode === 'direct'
    ? `Commits are pushed DIRECTLY to "${state.baseBranch}". Be careful: this is the branch people use.`
    : `Commits go to the working branch "${state.workBranch}" (created from "${state.baseBranch}"). ` +
      'After pushing, open a pull request unless the user asked you not to.';
  return [
    'You are ARO, the coding agent inside ARO AI. You work directly in the user\'s GitHub repository ' +
    `${state.repo.owner}/${state.repo.name} using tools.`,
    push,
    '',
    'How to work:',
    '1. Understand the request. Explore with list_files, search_code and read_file before changing anything.',
    '2. Make the smallest correct change. Match the existing code style. Prefer edit_file for small edits.',
    '3. Never add secrets (API keys, tokens, passwords, signing keys) to the repository.',
    '4. When the change is complete, call commit_and_push once with a clear message describing what and why.',
    '5. You cannot run code. Say what you could not verify, and use get_ci_status after pushing if the repo has CI.',
    '6. Finish with a short summary for the user: what you changed, which files, and anything they should check.',
    'If the request is unclear or risky (deleting lots of code, rewriting history), ask the user first instead of acting.',
  ].join('\n');
}

export async function handleRequest(req: Request, deps: AgentDeps): Promise<Response> {
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

  if (!isProviderId(body?.provider)) return errorResponse('provider must be one of: aro, claude, openai, gemini, qwen', 400);
  const githubToken = typeof body.githubToken === 'string' ? body.githubToken.trim() : '';
  if (!githubToken) return errorResponse('Connect GitHub first: Settings → GitHub.', 400);

  const owner = body.repo?.owner;
  const name = body.repo?.name;
  if (!isValidRepoName(owner) || !isValidRepoName(name)) return errorResponse('Invalid repository', 400);

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length > MAX_MESSAGE_CHARS) return errorResponse('Message is too long', 400);
  if (!message && body.continue !== true) return errorResponse('Send a message or continue: true', 400);

  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const db = deps.db === undefined ? dbFromEnv(env) : deps.db;

  let endpoints: Endpoint[];
  let aro: AroResolution | undefined;
  let aroNotice: string | undefined;
  try {
    if (body.provider === 'aro') {
      // The agent runs on ARO Code; if the user's plan doesn't include it,
      // ARO 1.5 does the work and the app says why. One request per run.
      const routing = [{ role: 'user' as const, content: message || 'continue' }];
      try {
        aro = await resolveAro(db, user.uid, 'aro-code', routing, env);
      } catch (err) {
        if (!(err instanceof ProviderError) || ![402, 429, 503].includes(err.status) || !db) throw err;
        aro = await resolveAro(db, user.uid, 'aro-1.5', routing, env);
        aroNotice = `${err.message} ARO 1.5 is working on this instead.`;
      }
      endpoints = aro.endpoints;
    } else {
      endpoints = resolveEndpoints(body.provider, body.model, body.apiKey, 'agent', env);
    }
  } catch (err) {
    return err instanceof ProviderError ? errorResponse(err.message, err.status) : errorResponse('Bad request', 400);
  }

  const github = new GitHubClient(githubToken, owner, name, deps.fetchImpl);

  let state: AgentState;
  if (body.state) {
    const parsed = parseState(body.state);
    if (typeof parsed === 'string') return errorResponse(parsed, 400);
    if (parsed.repo.owner !== owner || parsed.repo.name !== name) return errorResponse('State belongs to another repository', 400);
    state = parsed;
  } else {
    if (!message) return errorResponse('Start a session with a message', 400);
    const pushMode: PushMode = body.pushMode === 'direct' ? 'direct' : 'branch';
    let baseBranch = body.baseBranch;
    try {
      const info = await github.getRepo();
      if (!info.canPush) return errorResponse(`Your GitHub token can't push to ${owner}/${name}. Give it "Contents: Read and write" access.`, 403);
      baseBranch = isValidBranch(baseBranch) ? baseBranch : info.defaultBranch;
    } catch (err) {
      const status = err instanceof GitHubError ? err.status : 502;
      const hint = status === 401 ? 'Your GitHub token is invalid or expired.' : status === 404 ? `Repository ${owner}/${name} not found, or your token can't see it.` : (err as Error).message;
      return errorResponse(hint, status === 401 || status === 404 ? status : 502);
    }
    state = createState(owner, name, baseBranch, pushMode, message);
  }

  if (message) state.transcript.push({ role: 'user', text: message });

  const now = deps.now ?? Date.now;
  const budgetMs = Number(deps.env?.('AGENT_TIME_BUDGET_MS') ?? '') || DEFAULT_TIME_BUDGET_MS;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => controller.enqueue(sseFrame(payload));
      let status: 'completed' | 'paused' | 'error' = 'completed';
      const progress = { modelTurns: 0 };
      if (aroNotice) send({ type: 'status', text: aroNotice });
      if (aro) send({ type: 'model', aroModel: aro.aroModel, usage: { plan: aro.authorization.plan, remaining: aro.authorization.remaining ?? null } });
      try {
        status = await runAgent(state, endpoints, github, send, { fetchImpl: deps.fetchImpl, deadline: now() + budgetMs, now, progress });
      } catch (err) {
        status = 'error';
        send({ type: 'error', message: err instanceof Error ? err.message : 'Agent failed' });
        // The model never answered: give the request back.
        if (aro && db && progress.modelTurns === 0) {
          await refund(db, user.uid, aro.aroModel, aro.authorization.via).catch((e) => console.error('aro-agent: refund failed', e));
        }
      } finally {
        state.transcript = compactTranscript(state.transcript);
        send({ type: 'state', state });
        send({ type: 'done', status });
        controller.enqueue(SSE_DONE);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

interface RunOptions {
  fetchImpl?: typeof fetch;
  deadline: number;
  now: () => number;
  progress?: { modelTurns: number };
}

export async function runAgent(
  state: AgentState,
  endpoints: Endpoint[],
  github: GitHubClient,
  send: (payload: Record<string, unknown>) => void,
  options: RunOptions,
): Promise<'completed' | 'paused'> {
  const runner = new ToolRunner(github, state, (event) => send(event));
  const system = systemPrompt(state);

  for (let step = 0; step < MAX_STEPS_PER_REQUEST; step++) {
    if (options.now() > options.deadline) {
      send({ type: 'status', text: 'Paused to stay within the time limit — tap Continue to keep going.' });
      return 'paused';
    }

    send({ type: 'status', text: step === 0 ? 'Thinking…' : 'Working…' });
    const turn = await callWithFallback(endpoints, system, compactTranscript(state.transcript), options.fetchImpl);
    if (options.progress) options.progress.modelTurns++;

    const assistant: AgentMessage = {
      role: 'assistant',
      text: turn.text,
      toolCalls: turn.toolCalls,
      raw: turn.raw,
      rawKind: turn.rawKind,
    };
    state.transcript.push(assistant);
    if (turn.text) send({ type: 'text', text: turn.text });
    if (turn.toolCalls.length === 0) return 'completed';

    const results = [];
    for (const call of turn.toolCalls) {
      send({ type: 'tool', id: call.id, name: call.name, input: summarizeArgs(call) });
      const result = await runner.run(call);
      results.push(result);
      send({
        type: 'tool_result',
        id: call.id,
        name: call.name,
        ok: !result.isError,
        summary: result.content.split('\n')[0].slice(0, 200),
      });
    }
    state.transcript.push({ role: 'tool', results });
  }

  send({ type: 'status', text: 'Reached the step limit for one run — tap Continue to keep going.' });
  return 'paused';
}

async function callWithFallback(
  endpoints: Endpoint[],
  system: string,
  transcript: AgentMessage[],
  fetchImpl?: typeof fetch,
) {
  let lastError: unknown;
  for (const [index, endpoint] of endpoints.entries()) {
    try {
      return await chatWithTools(endpoint, system, transcript, TOOL_DEFINITIONS, { fetchImpl });
    } catch (err) {
      lastError = err;
      if (!(canTryNext(err) && index < endpoints.length - 1)) throw err;
    }
  }
  throw lastError;
}

/** Short, safe description of a tool call for the app's activity list. */
export function summarizeArgs(call: ToolCall): string {
  const a = call.args;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (call.name) {
    case 'read_file':
      return str(a.path) + (a.start_line ? `:${a.start_line}-${a.end_line ?? ''}` : '');
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return str(a.path);
    case 'list_files':
      return str(a.path) || '/';
    case 'search_code':
      return str(a.query).slice(0, 120);
    case 'commit_and_push':
      return str(a.message).split('\n')[0].slice(0, 120);
    case 'create_pull_request':
      return str(a.title).slice(0, 120);
    default:
      return '';
  }
}
