// The tools the ARO coding agent can use inside a user's GitHub repo.
// File edits are staged in AgentState.pending and land on GitHub as ONE
// commit when the agent calls commit_and_push.

import { type FileChanges, GitHubClient, GitHubError, type TreeEntry } from '../_shared/github.ts';
import type { ToolCall, ToolDefinition, ToolResult } from '../_shared/llm/tool_chat.ts';
import { CALC_TOOLS, runCalcTool } from '../_shared/calc.ts';
import { type JsonSchema, validate } from '../_shared/schema.ts';
import { readPage, type WebDeps, webSearch } from '../_shared/web.ts';
import {
  formatResult, isJobId, runSandbox, type SandboxDeps, SandboxError, type SandboxInput, type SandboxOutcome, sandboxResult, toolchainsFor,
} from '../_shared/sandbox.ts';
import { PLAN_TOOL, planFromArgs } from './plan.ts';
import type { AgentState } from './state.ts';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_files',
    description:
      'List file paths in the repository (including staged, uncommitted changes). Optionally only paths under a directory prefix.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory prefix, e.g. "src/". Omit for the whole repo.' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers. Use start_line/end_line for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      "Search the repository's code with GitHub code search (default branch only; very new commits may not be indexed). Returns matching paths and snippets.",
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file with new content (staged until commit_and_push).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact occurrence of old_text with new_text in a file (staged until commit_and_push). old_text must match exactly once, including whitespace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file (staged until commit_and_push).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'commit_and_push',
    description:
      'Commit every staged change as one commit and push it to the working branch on GitHub. Use a clear, specific commit message.',
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from the working branch into the base branch, after at least one commit.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'],
    },
  },
  {
    name: 'get_ci_status',
    description: 'Get the GitHub Actions / check-run results for the latest pushed commit.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'web_search',
    description:
      'Search the internet. Use it when the user asks you to look something up online, or to find current docs, ' +
      'error-message fixes, library versions or release notes. Returns titles, URLs and snippets.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'read_webpage',
    description: 'Read the text of a public web page (e.g. a result from web_search, docs, an issue thread).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  ...CALC_TOOLS,
  PLAN_TOOL,
];

/** Real execution (only offered when the sandbox is configured). */
export const SANDBOX_TOOLS: ToolDefinition[] = [
  {
    name: 'run_in_sandbox',
    description:
      'Run a shell command in an isolated Linux sandbox containing this repository at the working branch PLUS your staged ' +
      'changes (Python 3.12, pip, git, gcc/make; Node 22 and Go are installed automatically when the command uses them). ' +
      'Use it to run tests, linters, type checkers or a build before committing, e.g. "npm ci && npm test" or ' +
      '"pip install -r requirements.txt && pytest -q". Returns the exit code and output. No secrets are available; ' +
      'internet access is for installing packages.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 2000 },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 300 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_python',
    description: 'Run a Python 3.12 script in an isolated sandbox (no repository) and return its output. ' +
      'Use it for data processing or heavy maths that calculate cannot do.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1, maxLength: 20000 },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 300 },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'sandbox_result',
    description: 'Get the output of a sandbox job that was still running when its tool call returned.',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string', pattern: '^[A-Za-z0-9-]{8,80}$' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
];

export function toolDefinitions(options: { sandbox: boolean }): ToolDefinition[] {
  return options.sandbox ? [...TOOL_DEFINITIONS, ...SANDBOX_TOOLS] : TOOL_DEFINITIONS;
}

const TOOLS_BY_NAME = new Map([...TOOL_DEFINITIONS, ...SANDBOX_TOOLS].map((t) => [t.name, t]));
/** Sandbox jobs per request (each one is billed CPU time). */
export const MAX_SANDBOX_RUNS = 6;
const MAX_SANDBOX_FILE_BYTES = 6 * 1024 * 1024;

export interface TestPlan {
  command: string;
  toolchains: ('node' | 'go')[];
  /** e.g. "npm test", shown to the user. */
  label: string;
}

export interface SandboxSetup extends SandboxDeps {
  /** Epoch ms by which a tool call must return (the run's time budget). */
  deadline: () => number;
}

/** Tools that only read: safe to retry automatically on a transient GitHub/network error. */
const READ_ONLY = new Set(['list_files', 'read_file', 'search_code', 'get_ci_status', 'web_search', 'read_webpage']);

const MAX_TOOL_RETRIES = 3;

/** Paths whose changes always need the user's confirmation (CI, secrets, infrastructure, database migrations). */
const SENSITIVE_PATH = /(^|\/)(\.github\/workflows\/|\.gitlab-ci|\.circleci\/|Jenkinsfile|\.env|secrets?[./]|credentials|id_rsa|.*\.pem$|.*\.keystore$|.*\.jks$|Dockerfile|docker-compose|terraform\/|.*\.tf$|k8s\/|helm\/|supabase\/migrations\/|migrations\/)/i;
const MANY_FILES = 20;

export interface Confirmation {
  summary: string;
  details: string[];
}

const MAX_READ_CHARS = 60_000;
const MAX_LIST = 800;

/** Events the tool runner reports to the app as they happen. */
export type ToolEvent =
  | { type: 'commit'; sha: string; url: string; branch: string; message: string; files: string[] }
  | { type: 'pull_request'; number: number; url: string }
  | { type: 'plan'; plan: AgentState['plan'] };

export type SandboxRun = { outcome: SandboxOutcome; text: string };

export class ToolRunner {
  private tree: TreeEntry[] | null = null;
  private treeTruncated = false;
  private sandboxRuns = 0;

  constructor(
    private readonly github: GitHubClient,
    private readonly state: AgentState,
    private readonly emit: (event: ToolEvent) => void,
    private readonly web?: WebDeps,
    private readonly sandbox?: SandboxSetup,
  ) {}

  get sandboxEnabled(): boolean {
    return !!this.sandbox;
  }

  /** The ref to read from: the working branch once it exists on GitHub. */
  private get readRef(): string {
    return this.state.branchCreated ? this.state.workBranch : this.state.baseBranch;
  }

  /**
   * Runs one tool call. Arguments are validated against the tool's JSON Schema
   * first: an invalid call is never executed, and comes back as an error the
   * model can fix (`invalid: true`). Read-only tools retry transient failures.
   */
  async run(call: ToolCall): Promise<ToolResult> {
    const invalid = this.check(call);
    if (invalid) return invalid;
    for (let attempt = 1; ; attempt++) {
      try {
        return { id: call.id, name: call.name, content: await this.dispatch(call) };
      } catch (err) {
        const transient = err instanceof GitHubError ? err.status >= 500 || err.status === 429 : false;
        if (transient && READ_ONLY.has(call.name) && attempt < MAX_TOOL_RETRIES) {
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        return { id: call.id, name: call.name, content: message, isError: true };
      }
    }
  }

  /** Schema check only: an error result for an invalid call, or null when it may run. */
  check(call: ToolCall): ToolResult | null {
    const def = TOOLS_BY_NAME.get(call.name);
    if (!def) return { id: call.id, name: call.name, content: `Unknown tool "${call.name}".`, isError: true, invalid: true };
    if ('_invalid_json' in call.args) {
      return { id: call.id, name: call.name, content: 'The arguments were not valid JSON. Send a JSON object that matches the tool schema.', isError: true, invalid: true };
    }
    const problems = validate(def.parameters as JsonSchema, call.args);
    if (problems.length) {
      return {
        id: call.id, name: call.name, isError: true, invalid: true,
        content: `Invalid arguments for ${call.name}, so it was not run:\n- ${problems.join('\n- ')}\nFix them and call it again.`,
      };
    }
    return null;
  }

  /** The file as it is on GitHub (before staged edits), or null if it doesn't exist there. */
  async originalText(path: string): Promise<string | null> {
    return await this.github.readFile(path, this.readRef);
  }

  /**
   * High-stakes or irreversible actions need the user's explicit approval:
   * pushing straight to the base branch, deleting files, large or sensitive
   * commits (CI, secrets, infrastructure, migrations), and opening a pull
   * request (it notifies other people). Returns what to ask, or null.
   */
  needsConfirmation(call: ToolCall): Confirmation | null {
    if (call.name === 'create_pull_request') {
      return {
        summary: `Open a pull request "${String(call.args.title ?? '').slice(0, 120)}" from ${this.state.workBranch} into ${this.state.baseBranch}`,
        details: ['Collaborators on the repository may be notified.'],
      };
    }
    if (call.name !== 'commit_and_push') return null;
    const paths = Object.keys(this.state.pending);
    const deleted = paths.filter((p) => this.state.pending[p] === null);
    const sensitive = paths.filter((p) => SENSITIVE_PATH.test(p));
    const reasons: string[] = [];
    if (this.state.pushMode === 'direct') reasons.push(`pushes straight to "${this.state.baseBranch}" (no pull request to review first)`);
    if (deleted.length) reasons.push(`deletes ${deleted.length} file(s): ${deleted.slice(0, 10).join(', ')}`);
    if (sensitive.length) reasons.push(`changes sensitive files: ${sensitive.slice(0, 10).join(', ')}`);
    if (paths.length > MANY_FILES) reasons.push(`changes ${paths.length} files`);
    if (!reasons.length) return null;
    return {
      summary: `Commit and push "${String(call.args.message ?? '').split('\n')[0].slice(0, 120)}" (${paths.length} file(s))`,
      details: reasons,
    };
  }

  private async dispatch(call: ToolCall): Promise<string> {
    const args = call.args;
    switch (call.name) {
      case 'list_files':
        return await this.listFiles(optionalString(args.path));
      case 'read_file':
        return await this.readFile(requireString(args, 'path'), optionalInt(args.start_line), optionalInt(args.end_line));
      case 'search_code':
        return await this.searchCode(requireString(args, 'query'));
      case 'write_file':
        return this.stage(requireString(args, 'path'), requireString(args, 'content', true));
      case 'edit_file':
        return await this.editFile(
          requireString(args, 'path'),
          requireString(args, 'old_text', true),
          requireString(args, 'new_text', true),
        );
      case 'delete_file':
        return await this.deleteFile(requireString(args, 'path'));
      case 'commit_and_push':
        return await this.commitAndPush(requireString(args, 'message'));
      case 'create_pull_request':
        return await this.createPullRequest(requireString(args, 'title'), optionalString(args.body) ?? '');
      case 'get_ci_status':
        return await this.ciStatus();
      case 'web_search':
        return await this.webSearch(requireString(args, 'query'));
      case 'read_webpage':
        return await this.readWebpage(requireString(args, 'url'));
      case 'calculate':
      case 'date_math':
        return runCalcTool(call.name, args);
      case 'run_in_sandbox':
        return (await this.runCommand(requireString(args, 'command'), optionalInt(args.timeout_seconds) ?? 120)).text;
      case 'run_python':
        return (await this.runSandboxJob({ mode: 'python', code: requireString(args, 'code'), timeout_seconds: optionalInt(args.timeout_seconds) ?? 60 }, 'The script')).text;
      case 'sandbox_result':
        return (await this.collect(requireString(args, 'job_id'))).text;
      case 'set_plan': {
        this.state.plan = planFromArgs(args);
        this.state.planStale = false;
        this.emit({ type: 'plan', plan: this.state.plan });
        const done = this.state.plan.steps.filter((s) => s.status === 'done').length;
        return `Plan saved (${done}/${this.state.plan.steps.length} steps done). Keep it updated with set_plan as you finish steps.`;
      }
      default:
        throw new Error(`Unknown tool: ${call.name}`);
    }
  }

  /** Runs a command in the sandbox on the working branch plus the staged changes. */
  async runCommand(command: string, timeoutSeconds: number, label = 'The command'): Promise<SandboxRun> {
    const files = { ...this.state.pending };
    if (Object.values(files).reduce((n, c) => n + (c?.length ?? 0), 0) > MAX_SANDBOX_FILE_BYTES) {
      throw new Error('The staged changes are too large to send to the sandbox (6 MB max). Commit some first.');
    }
    const repoUrl = await this.github.tarballUrl(this.readRef);
    return await this.runSandboxJob(
      { mode: 'repo', repo_url: repoUrl, files, command, toolchains: toolchainsFor(command), timeout_seconds: Math.min(Math.max(timeoutSeconds, 10), 300) },
      label,
    );
  }

  private remainingWait(): number {
    // Leave time to report back before the request's time budget ends.
    return Math.max(0, Math.min(100_000, this.sandbox!.deadline() - (this.sandbox!.now ?? Date.now)() - 15_000));
  }

  private async runSandboxJob(input: SandboxInput, label: string): Promise<SandboxRun> {
    if (!this.sandbox) throw new Error('Code execution is not available here.');
    if (this.sandboxRuns >= MAX_SANDBOX_RUNS) {
      throw new Error(`Sandbox limit reached for this run (${MAX_SANDBOX_RUNS} jobs). Continue in the next step if more are needed.`);
    }
    this.sandboxRuns++;
    try {
      const outcome = await runSandbox(input, this.sandbox, this.remainingWait());
      this.state.sandboxJobs = [...(this.state.sandboxJobs ?? []), outcome.jobId].slice(-20);
      return { outcome, text: this.describe(outcome, label) };
    } catch (err) {
      throw err instanceof SandboxError ? new Error(err.message) : err;
    }
  }

  /** Collects a job started earlier in this session (and only those). */
  async collect(jobId: string): Promise<SandboxRun> {
    if (!this.sandbox) throw new Error('Code execution is not available here.');
    if (!isJobId(jobId) || !(this.state.sandboxJobs ?? []).includes(jobId)) throw new Error(`Unknown sandbox job "${jobId}".`);
    try {
      const outcome = await sandboxResult(jobId, this.sandbox, this.remainingWait());
      // The pre-commit test job finished: remember whether these changes passed.
      if (outcome.state === 'done' && this.state.verified?.jobId === jobId) {
        const passed = outcome.result.exit_code === 0 && !outcome.result.timed_out;
        this.state.verified = passed ? { hash: this.state.verified.hash, passed: true } : undefined;
      }
      return { outcome, text: this.describe(outcome, 'The job') };
    } catch (err) {
      throw err instanceof SandboxError ? new Error(err.message) : err;
    }
  }

  private describe(outcome: SandboxOutcome, label: string): string {
    return outcome.state === 'done'
      ? formatResult(outcome.result, label)
      : `${label} is still running in the sandbox (job ${outcome.jobId}). Call sandbox_result with job_id "${outcome.jobId}" to get the output.`;
  }

  /**
   * The repository's test command, if it has a standard one (checked at the
   * repository root, including staged changes): npm/yarn/pnpm "test" script,
   * pytest, or Go tests.
   */
  async detectTests(): Promise<TestPlan | null> {
    const files = new Set((await this.loadTree()).filter((e) => e.type === 'blob').map((e) => e.path));
    for (const [path, content] of Object.entries(this.state.pending)) content === null ? files.delete(path) : files.add(path);
    if (files.has('package.json')) {
      try {
        const pkg = JSON.parse((await this.currentText('package.json')) ?? '{}');
        const test = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test : '';
        if (test && !/no test specified/i.test(test)) {
          const corepack = 'corepack enable --install-directory "$HOME/.local/bin"';
          if (files.has('pnpm-lock.yaml')) return { command: `${corepack} && pnpm install --frozen-lockfile && pnpm test`, toolchains: ['node'], label: 'pnpm test' };
          if (files.has('yarn.lock')) return { command: `${corepack} && yarn install && yarn test`, toolchains: ['node'], label: 'yarn test' };
          const install = files.has('package-lock.json') ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
          return { command: `${install} && npm test`, toolchains: ['node'], label: 'npm test' };
        }
      } catch { /* not valid JSON: no npm tests */ }
    }
    const pyTests = [...files].some((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f));
    const pyConfig = files.has('pytest.ini') || files.has('conftest.py') ||
      (files.has('pyproject.toml') && /\[tool\.pytest/.test((await this.currentText('pyproject.toml')) ?? ''));
    if (pyTests || pyConfig) {
      const steps = ['python3 -m venv .venv', '. .venv/bin/activate', 'pip install -q pytest'];
      if (files.has('requirements.txt')) steps.push('pip install -q -r requirements.txt');
      if (files.has('pyproject.toml') || files.has('setup.py')) steps.push('(pip install -q -e . || true)');
      steps.push('python -m pytest -q -x');
      return { command: steps.join(' && '), toolchains: [], label: 'pytest' };
    }
    if (files.has('go.mod')) return { command: 'go test ./...', toolchains: ['go'], label: 'go test' };
    return null;
  }

  private async webSearch(query: string): Promise<string> {
    if (!this.web) throw new Error('Web search is not available here.');
    const { provider, results } = await webSearch(query, this.web, 6);
    if (!results.length) return `No web results for "${query}" (${provider}).`;
    return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n') +
      '\n\nUse read_webpage on the most relevant result before relying on it, and cite the URLs you used.';
  }

  private async readWebpage(url: string): Promise<string> {
    if (!this.web) throw new Error('Reading web pages is not available here.');
    const page = await readPage(url, this.web, 12_000);
    return `${page.title}\n${page.url}\n\n${page.text || '(no readable text)'}`;
  }

  private async loadTree(): Promise<TreeEntry[]> {
    if (!this.tree) {
      const { entries, truncated } = await this.github.listTree(this.readRef);
      this.tree = entries;
      this.treeTruncated = truncated;
    }
    return this.tree;
  }

  private async listFiles(prefix?: string): Promise<string> {
    const normalized = prefix ? safePath(prefix.replace(/\/+$/, '')) + '/' : '';
    const files = new Set(
      (await this.loadTree()).filter((e) => e.type === 'blob').map((e) => e.path),
    );
    for (const [path, content] of Object.entries(this.state.pending)) {
      if (content === null) files.delete(path);
      else files.add(path);
    }
    const matching = [...files].filter((p) => p.startsWith(normalized)).sort();
    const shown = matching.slice(0, MAX_LIST);
    const notes: string[] = [];
    if (matching.length > shown.length) notes.push(`(${matching.length - shown.length} more not shown — narrow the path)`);
    if (this.treeTruncated) notes.push('(GitHub truncated the tree for this large repo — list a subdirectory)');
    if (shown.length === 0) return normalized ? `No files under ${normalized}` : 'The repository is empty.';
    return [...shown.map((p) => (p in this.state.pending ? `${p}  [staged]` : p)), ...notes].join('\n');
  }

  private async currentText(path: string): Promise<string | null> {
    if (path in this.state.pending) return this.state.pending[path];
    return await this.github.readFile(path, this.readRef);
  }

  private async readFile(rawPath: string, start?: number, end?: number): Promise<string> {
    const path = safePath(rawPath);
    const text = await this.currentText(path);
    if (text === null) throw new Error(`File not found: ${path}`);
    if (text.includes('\u0000')) return `${path} looks like a binary file; it can't be shown as text.`;

    const lines = text.split('\n');
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? lines.length);
    let out = '';
    for (let i = from; i <= to; i++) {
      const line = `${String(i).padStart(5)}  ${lines[i - 1]}\n`;
      if (out.length + line.length > MAX_READ_CHARS) {
        out += `… (stopped at line ${i - 1} of ${lines.length}; read again with start_line=${i})\n`;
        break;
      }
      out += line;
    }
    return `${path} (${lines.length} lines)\n${out}`;
  }

  private async searchCode(query: string): Promise<string> {
    const hits = await this.github.searchCode(query);
    if (hits.length === 0) return 'No matches. Try another query, or use list_files and read_file.';
    return hits
      .map((h) => [h.path, ...h.fragments.slice(0, 2).map((f) => `    ${f.replace(/\n/g, '\n    ')}`)].join('\n'))
      .join('\n\n');
  }

  private stage(rawPath: string, content: string): string {
    const path = safePath(rawPath);
    this.state.pending[path] = content;
    return `Staged ${path} (${content.split('\n').length} lines). Remember to commit_and_push when the change is complete.`;
  }

  private async editFile(rawPath: string, oldText: string, newText: string): Promise<string> {
    const path = safePath(rawPath);
    if (!oldText) throw new Error('old_text must not be empty');
    const text = await this.currentText(path);
    if (text === null) throw new Error(`File not found: ${path}`);
    const count = text.split(oldText).length - 1;
    if (count === 0) throw new Error(`old_text was not found in ${path}. Read the file again and copy the text exactly.`);
    if (count > 1) throw new Error(`old_text appears ${count} times in ${path}. Include more surrounding lines so it is unique.`);
    this.state.pending[path] = text.replace(oldText, () => newText);
    return `Edited ${path} (staged).`;
  }

  private async deleteFile(rawPath: string): Promise<string> {
    const path = safePath(rawPath);
    const exists = path in this.state.pending ? this.state.pending[path] !== null : (await this.github.readFile(path, this.readRef)) !== null;
    if (!exists) throw new Error(`File not found: ${path}`);
    this.state.pending[path] = null;
    return `Deleted ${path} (staged).`;
  }

  private async commitAndPush(message: string): Promise<string> {
    const changes: FileChanges = { ...this.state.pending };
    const paths = Object.keys(changes);
    if (paths.length === 0) throw new Error('Nothing to commit — no staged changes.');
    if (this.state.workBranch === this.state.baseBranch && this.state.pushMode !== 'direct') {
      throw new Error('Pushing directly to the base branch is turned off for this repo.');
    }

    const leaks = findSecrets(changes);
    if (leaks.length) {
      throw new Error(
        `Refusing to commit: ${leaks.join(', ')} look like they contain secrets (keys, tokens or passwords). Remove them and use environment variables instead.`,
      );
    }

    if (!this.state.branchCreated) {
      const existing = await this.github.branchSha(this.state.workBranch);
      if (!existing) {
        const baseSha = await this.github.branchSha(this.state.baseBranch);
        if (!baseSha) throw new Error(`Base branch ${this.state.baseBranch} not found.`);
        await this.github.createBranch(this.state.workBranch, baseSha);
      }
      this.state.branchCreated = true;
    }

    const modes: Record<string, string> = {};
    for (const entry of await this.loadTree()) {
      if (entry.path in changes && entry.mode !== '100644') modes[entry.path] = entry.mode;
    }

    const commit = await this.github.commitChanges(this.state.workBranch, message, changes, modes);
    this.state.pending = {};
    this.state.reviewRejections = 0;
    this.state.testFailures = 0;
    this.state.verified = undefined;
    this.tree = null;
    this.state.commits.push({ sha: commit.sha, url: commit.url, message, files: paths });
    this.emit({ type: 'commit', ...commit, branch: this.state.workBranch, message, files: paths });
    return `Pushed commit ${commit.sha.slice(0, 7)} to ${this.state.workBranch} (${paths.length} file(s)): ${commit.url}`;
  }

  private async createPullRequest(title: string, body: string): Promise<string> {
    if (this.state.pullRequest) return `A pull request already exists: ${this.state.pullRequest.url}`;
    if (this.state.workBranch === this.state.baseBranch) {
      throw new Error('Changes were pushed straight to the base branch, so there is nothing to open a pull request for.');
    }
    if (this.state.commits.length === 0) throw new Error('Commit and push changes before opening a pull request.');
    const footer = '\n\n---\n_Opened by ARO AI_';
    const pr = await this.github.createPullRequest(this.state.workBranch, this.state.baseBranch, title, body + footer);
    this.state.pullRequest = pr;
    this.emit({ type: 'pull_request', ...pr });
    return `Opened pull request #${pr.number}: ${pr.url}`;
  }

  private async ciStatus(): Promise<string> {
    const last = this.state.commits.at(-1);
    if (!last) return 'No commits pushed yet in this session.';
    const runs = await this.github.checkRuns(last.sha);
    if (runs.length === 0) return `No checks reported yet for ${last.sha.slice(0, 7)} (the repo may have no CI, or it has not started).`;
    return runs.map((r) => `${r.name}: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''}`).join('\n');
  }
}

// ------------------------------------------------------------- validation

export function safePath(raw: string): string {
  const path = raw.trim().replace(/^\.\/+/, '');
  if (!path || path.length > 400) throw new Error('Invalid path');
  if (path.startsWith('/') || path.includes('\\')) throw new Error(`Invalid path: ${raw}`);
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`Invalid path: ${raw}`);
  if (segments[0] === '.git') throw new Error('The .git directory cannot be edited');
  return path;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{32,}\b/, // OpenAI / Anthropic keys
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
];

const SECRET_FILES = /(^|\/)(\.env(\..+)?|.*\.(jks|keystore|p12|pem)|id_rsa|key\.properties|service-account.*\.json)$/;

export function findSecrets(changes: FileChanges): string[] {
  const flagged: string[] = [];
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) continue;
    if (/(^|\/)\.env\.(example|sample|template)$/.test(path)) continue;
    if (SECRET_FILES.test(path) || SECRET_PATTERNS.some((re) => re.test(content))) flagged.push(path);
  }
  return flagged;
}

function requireString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`Missing argument: ${key}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

export { GitHubError };
