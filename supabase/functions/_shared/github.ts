// Minimal GitHub REST client for the ARO coding agent. It uses the user's
// own token (fine-grained personal access token) for every call, so the
// agent can never reach a repository the user can't.

import { shortError } from './http.ts';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

/** A staged change: new file content, or null to delete the file. */
export type FileChanges = Record<string, string | null>;

export interface SearchHit {
  path: string;
  fragments: string[];
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    readonly owner: string,
    readonly repo: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get fullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aro-ai-agent',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch { /* not JSON */ }
      throw new GitHubError(`GitHub ${method} ${path.split('?')[0]} failed (${response.status}): ${shortError(message, 300)}`, response.status);
    }
    return response;
  }

  private async json(method: string, path: string, body?: unknown): Promise<any> {
    return await (await this.request(method, path, body)).json();
  }

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
  }

  async getRepo(): Promise<{ defaultBranch: string; private: boolean; canPush: boolean }> {
    const data = await this.json('GET', this.repoPath(''));
    return {
      defaultBranch: data.default_branch,
      private: data.private === true,
      canPush: data.permissions?.push === true,
    };
  }

  /** Commit SHA a branch points at, or null if the branch does not exist. */
  async branchSha(branch: string): Promise<string | null> {
    try {
      const data = await this.json('GET', this.repoPath(`/git/ref/heads/${encodeRef(branch)}`));
      return data.object?.sha ?? null;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async createBranch(branch: string, fromSha: string): Promise<void> {
    await this.json('POST', this.repoPath('/git/refs'), { ref: `refs/heads/${branch}`, sha: fromSha });
  }

  async listTree(ref: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const data = await this.json('GET', this.repoPath(`/git/trees/${encodeURIComponent(ref)}?recursive=1`));
    return { entries: (data.tree ?? []) as TreeEntry[], truncated: data.truncated === true };
  }

  /** Raw file text at a ref, or null when the file doesn't exist there. */
  async readFile(path: string, ref: string): Promise<string | null> {
    try {
      const response = await this.request(
        'GET',
        this.repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`),
        undefined,
        'application/vnd.github.raw+json',
      );
      return await response.text();
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async searchCode(query: string, limit = 20): Promise<SearchHit[]> {
    const q = encodeURIComponent(`${query} repo:${this.fullName}`);
    const response = await this.request(
      'GET',
      `/search/code?q=${q}&per_page=${limit}`,
      undefined,
      'application/vnd.github.text-match+json',
    );
    const data = await response.json();
    return (data.items ?? []).map((item: any) => ({
      path: item.path,
      fragments: (item.text_matches ?? []).map((m: any) => String(m.fragment ?? '')).filter(Boolean),
    }));
  }

  /**
   * Creates ONE commit containing every staged change and moves `branch`
   * to it (fast-forward only — never a force push).
   */
  async commitChanges(
    branch: string,
    message: string,
    changes: FileChanges,
    modes: Record<string, string> = {},
  ): Promise<{ sha: string; url: string }> {
    const headSha = await this.branchSha(branch);
    if (!headSha) throw new GitHubError(`Branch ${branch} does not exist`, 404);
    const head = await this.json('GET', this.repoPath(`/git/commits/${headSha}`));

    const tree = Object.entries(changes).map(([path, content]) =>
      content === null
        ? { path, mode: modes[path] ?? '100644', type: 'blob', sha: null }
        : { path, mode: modes[path] ?? '100644', type: 'blob', content }
    );
    const newTree = await this.json('POST', this.repoPath('/git/trees'), { base_tree: head.tree.sha, tree });
    const commit = await this.json('POST', this.repoPath('/git/commits'), {
      message,
      tree: newTree.sha,
      parents: [headSha],
    });
    await this.json('PATCH', this.repoPath(`/git/refs/heads/${encodeRef(branch)}`), { sha: commit.sha, force: false });
    return { sha: commit.sha, url: `https://github.com/${this.fullName}/commit/${commit.sha}` };
  }

  async createPullRequest(head: string, base: string, title: string, body: string): Promise<{ number: number; url: string }> {
    const data = await this.json('POST', this.repoPath('/pulls'), { head, base, title, body });
    return { number: data.number, url: data.html_url };
  }

  async checkRuns(sha: string): Promise<CheckRun[]> {
    const data = await this.json('GET', this.repoPath(`/commits/${sha}/check-runs?per_page=50`));
    return (data.check_runs ?? []).map((run: any) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      url: run.html_url,
    }));
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}
