import { getTraceHeaders } from '../lib/request-context';

const GITHUB_API = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export class GitHubInstallationAuthorizationError extends Error {
  constructor(message = 'GitHub installation owner authorization is required') {
    super(message);
    this.name = 'GitHubInstallationAuthorizationError';
  }
}

// 'managed' = a Kortix-managed git token minted server-side by the managed backend.
// 'project_credential' = provider-neutral git credential stored outside
// user-readable runtime secrets.
// Both ride this auth context because callers only consume `.token` for git
// transport; GitHub API calls (ghFetch) are only made for actual GitHub repos.
type GitHubAuthSource =
  | 'app_installation'
  | 'nango'
  | 'pat'
  | 'managed'
  | 'project_credential';

export interface GitHubAuthContext {
  token: string;
  source: GitHubAuthSource;
  owner?: string;
  ownerType?: string;
  installationId?: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  description: string | null;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  };
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

interface GitHubRepositorySearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepo[];
}

export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  const m =
    repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export interface GitHubAppInstallation {
  id: number;
  account?: {
    login?: string;
    type?: string;
  };
  target_type?: string;
  repository_selection?: string;
  permissions?: Record<string, unknown>;
  html_url?: string;
}

export interface CreateRepoInput {
  name: string;
  isPrivate?: boolean;
  description?: string;
  autoInit?: boolean;
  owner?: string;
  auth?: GitHubAuthContext;
}

function requestToken(auth?: Pick<GitHubAuthContext, 'token'>) {
  if (auth?.token) return auth.token;
  throw new Error('GitHub authorization is not configured for this request');
}

function headers(auth?: Pick<GitHubAuthContext, 'token'>): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': `Bearer ${requestToken(auth)}`,
    'User-Agent': 'kortix-api',
    'Content-Type': 'application/json',
    ...getTraceHeaders(),
  };
}

async function ghFetch<T>(
  path: string,
  init?: RequestInit,
  auth?: Pick<GitHubAuthContext, 'token'>,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...headers(auth), ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { message?: string; errors?: Array<{ message?: string }> };
      detail = body.message ?? body.errors?.[0]?.message ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new GitHubApiError(
      `GitHub ${path} failed (${res.status}): ${detail || res.statusText}`,
      res.status,
      path,
      res.headers.get('retry-after') ?? undefined,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function getGitHubAppInstallationWithJwt(
  installationId: string,
  appJwt: string,
): Promise<GitHubAppInstallation> {
  const id = installationId.trim();
  const token = appJwt.trim();
  if (!id) throw new Error('installation_id is required');
  if (!token) throw new Error('GitHub App authorization is required');
  return ghFetch<GitHubAppInstallation>(
    `/app/installations/${encodeURIComponent(id)}`,
    { method: 'GET' },
    { token },
  );
}

/**
 * Read one installation through a GitHub App user access token.
 *
 * GitHub returns only installations that the authenticated user can access.
 * Nango's github-app-oauth credential supplies this user access token.
 */
export async function getGitHubAppInstallationForUserToken(
  userToken: string,
  installationId: string,
): Promise<GitHubAppInstallation> {
  const token = userToken.trim();
  const id = installationId.trim();
  if (!token) throw new Error('GitHub user authorization is required');
  if (!id) throw new Error('installation_id is required');

  for (let page = 1; page <= 100; page += 1) {
    let response: {
      total_count: number;
      installations: GitHubAppInstallation[];
    };
    try {
      response = await ghFetch<{
        total_count: number;
        installations: GitHubAppInstallation[];
      }>(
        `/user/installations?per_page=100&page=${page}`,
        { method: 'GET' },
        { token },
      );
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 401 || error.status === 403 || error.status === 404)
      ) {
        throw new GitHubInstallationAuthorizationError();
      }
      throw error;
    }
    const match = response.installations.find(
      (installation) => String(installation.id) === id,
    );
    if (match) return match;
    if (response.installations.length < 100) break;
  }
  throw new GitHubInstallationAuthorizationError();
}

export async function verifyGitHubInstallationAdmin(
  userToken: string,
  installation: GitHubAppInstallation,
): Promise<{ login: string }> {
  const token = userToken.trim();
  if (!token) {
    throw new GitHubInstallationAuthorizationError(
      'GitHub authorization is required to link this installation',
    );
  }

  const ownerLogin = installation.account?.login?.trim();
  if (!ownerLogin) {
    throw new GitHubInstallationAuthorizationError(
      'GitHub installation did not include an owner account',
    );
  }

  let user: { login?: string };
  try {
    user = await ghFetch<{ login?: string }>('/user', { method: 'GET' }, { token });
  } catch {
    throw new GitHubInstallationAuthorizationError(
      'GitHub user authorization is invalid or expired',
    );
  }

  const login = user.login?.trim();
  if (!login) {
    throw new GitHubInstallationAuthorizationError(
      'GitHub did not return the authorized user login',
    );
  }

  const ownerType = installation.account?.type ?? installation.target_type;
  if (ownerType === 'User') {
    if (login.toLowerCase() !== ownerLogin.toLowerCase()) {
      throw new GitHubInstallationAuthorizationError(
        'The authorized GitHub user does not own this installation',
      );
    }
    return { login };
  }

  let membership: { state?: string; role?: string };
  try {
    membership = await ghFetch<{ state?: string; role?: string }>(
      `/orgs/${encodeURIComponent(ownerLogin)}/memberships/${encodeURIComponent(login)}`,
      { method: 'GET' },
      { token },
    );
  } catch {
    throw new GitHubInstallationAuthorizationError(
      'GitHub organization admin access is required to link this installation',
    );
  }

  if (membership.state !== 'active' || membership.role !== 'admin') {
    throw new GitHubInstallationAuthorizationError(
      'GitHub organization admin access is required to link this installation',
    );
  }
  return { login };
}

/** List repositories visible to a Nango-resolved GitHub credential. */
export async function listOwnerRepositories(input: {
  owner: string;
  ownerType?: 'User' | 'Organization';
  auth: Pick<GitHubAuthContext, 'token'>;
  search?: string;
  limit?: number;
}): Promise<GitHubRepo[]> {
  const isOrg = input.ownerType
    ? input.ownerType !== 'User'
    : await isOrgAccount(input.owner, input.auth);
  const limit = normalizeRepositoryLimit(input.limit);
  const search = input.search?.trim();
  if (search) {
    return searchRepositories({
      owner: input.owner,
      ownerType: isOrg ? 'Organization' : 'User',
      search,
      limit,
      auth: input.auth,
    });
  }

  const params = new URLSearchParams(
    isOrg
      ? { type: 'all' }
      : { affiliation: 'owner,collaborator' },
  );
  params.set('sort', 'updated');
  params.set('direction', 'desc');
  params.set('per_page', String(limit));
  params.set('page', '1');
  const path = isOrg
    ? `/orgs/${encodeURIComponent(input.owner)}/repos?${params.toString()}`
    : `/user/repos?${params.toString()}`;
  const repositories = await ghFetch<GitHubRepo[]>(path, { method: 'GET' }, input.auth);
  return isOrg
    ? repositories
    : repositories.filter(
        (repo) => repo.full_name.split('/')[0]?.toLowerCase() === input.owner.toLowerCase(),
      );
}

function normalizeRepositoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

async function searchRepositories(input: {
  owner: string;
  ownerType: 'User' | 'Organization';
  search: string;
  limit: number;
  auth: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubRepo[]> {
  const qualifier = input.ownerType === 'Organization' ? 'org' : 'user';
  const params = new URLSearchParams({
    q: `${qualifier}:${input.owner} ${input.search} in:name,description`,
    sort: 'updated',
    order: 'desc',
    per_page: String(input.limit),
    page: '1',
  });
  const result = await ghFetch<GitHubRepositorySearchResponse>(
    `/search/repositories?${params.toString()}`,
    { method: 'GET' },
    input.auth,
  );
  return result.items ?? [];
}

export async function listRepositoryBranches(input: {
  owner: string;
  repo: string;
  auth: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubBranch[]> {
  const perPage = 100;
  const branches: GitHubBranch[] = [];

  for (let page = 1; ; page += 1) {
    const pageBranches = await ghFetch<GitHubBranch[]>(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}` +
        `/branches?per_page=${perPage}&page=${page}`,
      { method: 'GET' },
      input.auth,
    );
    branches.push(...pageBranches);
    if (pageBranches.length < perPage) return branches;
  }
}

export async function getRepositoryBranch(input: {
  owner: string;
  repo: string;
  branch: string;
  auth: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubBranch> {
  return ghFetch<GitHubBranch>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}` +
      `/branches/${encodeURIComponent(input.branch)}`,
    { method: 'GET' },
    input.auth,
  );
}

export async function getRepo(opts: {
  owner: string;
  repo: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubRepo> {
  return ghFetch<GitHubRepo>(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`,
    { method: 'GET' },
    opts.auth,
  );
}

/** Resolve a GitHub account type for repository listing. */
const accountTypeCache = new Map<string, boolean>();
export async function isOrgAccount(
  login: string,
  auth?: Pick<GitHubAuthContext, 'token'>,
): Promise<boolean> {
  const key = login.toLowerCase();
  const cached = accountTypeCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const acc = await ghFetch<{ type?: string }>(`/users/${encodeURIComponent(login)}`, undefined, auth);
    const isOrg = (acc.type ?? 'Organization') === 'Organization';
    accountTypeCache.set(key, isOrg);
    return isOrg;
  } catch {
    return true;
  }
}

async function resolveDefaultOwner(auth?: GitHubAuthContext): Promise<{ owner: string; isOrg: boolean }> {
  if (auth?.owner) {
    return { owner: auth.owner, isOrg: auth.ownerType !== 'User' };
  }

  // App-only: the installation auth context carries the owner. Fall back to
  // the token's authenticated account only if it somehow wasn't provided.
  const me = await ghFetch<{ login: string }>(`/user`, undefined, auth);
  return { owner: me.login, isOrg: false };
}

export function githubRepositoryCreatePath(input: {
  owner: string;
  ownerType: 'User' | 'Organization';
}): string {
  return input.ownerType === 'User'
    ? '/user/repos'
    : `/orgs/${encodeURIComponent(input.owner)}/repos`;
}

export async function createRepo(input: CreateRepoInput): Promise<GitHubRepo> {
  const ownerInput = input.owner?.trim();
  if (input.auth?.owner && ownerInput && ownerInput.toLowerCase() !== input.auth.owner.toLowerCase()) {
    throw new Error('GitHub owner must match the selected Nango connection');
  }

  const target = await resolveDefaultOwner(input.auth);

  const body = {
    name: input.name,
    description: input.description,
    private: input.isPrivate ?? true,
    auto_init: input.autoInit ?? true,
  };

  const path = githubRepositoryCreatePath({
    owner: target.owner,
    ownerType: target.isOrg ? 'Organization' : 'User',
  });
  return ghFetch<GitHubRepo>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  }, input.auth);
}

/** Delete a repo. Best-effort teardown for managed-repo rollback / removal. */
export async function deleteRepo(opts: {
  owner: string;
  repo: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<void> {
  await ghFetch<unknown>(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`,
    { method: 'DELETE' },
    opts.auth,
  );
}

export interface GitHubInvitation {
  /** Present when GitHub created a pending invitation (user not yet a member). */
  id?: number;
  html_url?: string;
  permissions?: string;
  invitee?: { login?: string };
}

/**
 * Add a collaborator to a repo (or update their permission). On a repo the user
 * isn't already on, GitHub creates a pending invitation they accept on
 * github.com; returns the invitation (204/no body when already a collaborator).
 * Requires an Administration:write-capable credential on the repo.
 */
export async function addCollaborator(opts: {
  owner: string;
  repo: string;
  username: string;
  /** GitHub permission: pull | triage | push | maintain | admin. */
  permission?: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubInvitation | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/collaborators/${encodeURIComponent(opts.username)}`,
    {
      method: 'PUT',
      headers: headers(opts.auth),
      body: JSON.stringify({ permission: opts.permission ?? 'push' }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (res.status === 204) return null; // already a collaborator
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub add collaborator failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json().catch(() => null) as Promise<GitHubInvitation | null>;
}

export async function getBranchCommitSha(opts: {
  owner: string;
  repo: string;
  branch: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<string> {
  const ref = encodeURIComponent(`heads/${opts.branch}`);
  const body = await ghFetch<{ object?: { sha?: string; type?: string } }>(
    `/repos/${opts.owner}/${opts.repo}/git/ref/${ref}`,
    undefined,
    opts.auth,
  );
  const sha = body.object?.sha;
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`GitHub branch ${opts.branch} did not resolve to a commit SHA`);
  }
  return sha;
}

export async function createBranchRef(opts: {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<void> {
  await ghFetch(`/repos/${opts.owner}/${opts.repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${opts.branch}`,
      sha: opts.sha,
    }),
  }, opts.auth);
}

/**
 * Write a single file to a repo via the GitHub Contents API.
 * Used by the starter scaffold — one commit per file under the default
 * branch. If the file already exists (e.g. `README.md` from `auto_init`),
 * pass `existingSha` and the call upserts instead of failing.
 */
export async function commitFile(opts: {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  branch?: string;
  existingSha?: string;
  authorName?: string;
  authorEmail?: string;
  auth?: GitHubAuthContext;
}): Promise<void> {
  // Pin the commit identity explicitly. Without an `author`/`committer` the
  // Contents API attributes the commit to whoever owns the token — which, on a
  // server-side PAT, surfaces a personal GitHub user (e.g. "markokraemer
  // committed") instead of Kortix. Defaulting here mirrors the identity used by
  // every git-CLI commit path (branches.ts / merge.ts / seed.ts).
  const ident = {
    name: opts.authorName || 'Kortix',
    email: opts.authorEmail || 'noreply@kortix.ai',
  };
  const body: Record<string, unknown> = {
    message: opts.message,
    content: Buffer.from(opts.content, 'utf8').toString('base64'),
    author: ident,
    committer: ident,
  };
  if (opts.branch) body.branch = opts.branch;
  if (opts.existingSha) body.sha = opts.existingSha;

  await ghFetch(`/repos/${opts.owner}/${opts.repo}/contents/${encodeURI(opts.path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, opts.auth);
}

/** GET an existing file's blob sha so `commitFile` can upsert. Returns null
 * if the file doesn't exist. */
export async function getFileSha(opts: {
  owner: string;
  repo: string;
  path: string;
  branch?: string;
  auth?: GitHubAuthContext;
}): Promise<string | null> {
  try {
    const qs = opts.branch ? `?ref=${encodeURIComponent(opts.branch)}` : '';
    const res = await ghFetch<{ sha: string }>(
      `/repos/${opts.owner}/${opts.repo}/contents/${encodeURI(opts.path)}${qs}`,
      undefined,
      opts.auth,
    );
    return res.sha ?? null;
  } catch {
    return null;
  }
}
