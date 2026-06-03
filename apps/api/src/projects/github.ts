import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { getTraceHeaders } from '../lib/request-context';

const GITHUB_API = 'https://api.github.com';

// 'managed' = a Kortix-managed git token minted server-side by the managed backend.
// 'project_credential' = provider-neutral git credential stored outside
// user-readable runtime secrets.
// Both ride this auth context because callers only consume `.token` for git
// transport; GitHub API calls (ghFetch) are only made for actual GitHub repos.
type GitHubAuthSource = 'app_installation' | 'pat' | 'managed' | 'project_credential';

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
}

interface GitHubInstallationRepositories {
  total_count: number;
  repositories: GitHubRepo[];
}

export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  const m =
    repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export interface GitHubInstallationToken {
  token: string;
  expires_at: string;
  permissions?: Record<string, unknown>;
  repository_selection?: string;
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

function githubAppId() {
  return process.env.KORTIX_GITHUB_APP_ID || process.env.GITHUB_APP_ID || null;
}

function githubAppPrivateKey() {
  return process.env.KORTIX_GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY || null;
}

function githubAppSlug() {
  return process.env.KORTIX_GITHUB_APP_SLUG || process.env.GITHUB_APP_SLUG || null;
}

export function isGithubAppConfigured() {
  return Boolean(githubAppId() && githubAppPrivateKey());
}

function githubAppStateSecret() {
  return (
    process.env.KORTIX_GITHUB_APP_STATE_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    githubAppPrivateKey() ||
    null
  );
}

function signGitHubAppStatePayload(payload: string) {
  const secret = githubAppStateSecret();
  if (!secret) {
    throw new Error('GitHub App install state secret is not configured');
  }
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface GitHubAppInstallState {
  accountId: string;
  nonce?: string;
  issuedAt: number;
}

function buildGitHubAppInstallState(
  accountId: string,
  options: { nonce?: string } = {},
  nowMs = Date.now(),
) {
  const payload = Buffer.from(JSON.stringify({
    account_id: accountId,
    nonce: options.nonce,
    iat: Math.floor(nowMs / 1000),
  })).toString('base64url');
  return `v1.${payload}.${signGitHubAppStatePayload(payload)}`;
}

export function verifyGitHubAppInstallStatePayload(state: string, nowMs = Date.now()): GitHubAppInstallState | null {
  const parts = state.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const payload = parts[1]!;
  const signature = parts[2]!;
  let expected: string;
  try {
    expected = signGitHubAppStatePayload(payload);
  } catch {
    return null;
  }
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      account_id?: unknown;
      nonce?: unknown;
      iat?: unknown;
    };
    const accountId = typeof decoded.account_id === 'string' ? decoded.account_id : '';
    const nonce = typeof decoded.nonce === 'string' ? decoded.nonce : undefined;
    const issuedAt = typeof decoded.iat === 'number' ? decoded.iat : 0;
    const now = Math.floor(nowMs / 1000);
    if (!accountId || issuedAt < now - 30 * 60 || issuedAt > now + 60) return null;
    return { accountId, nonce, issuedAt };
  } catch {
    return null;
  }
}

export function buildGitHubAppInstallUrl(accountId?: string | null, nonce?: string) {
  const slug = githubAppSlug()?.trim();
  if (!slug) return null;
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  if (accountId) {
    try {
      url.searchParams.set('state', buildGitHubAppInstallState(accountId, { nonce }));
    } catch {
      return null;
    }
  }
  return url.toString();
}

function normalizeGitHubPrivateKey(value: string) {
  return value.trim().replace(/\\n/g, '\n');
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createGitHubAppJwt(nowMs = Date.now()) {
  const appId = githubAppId()?.trim();
  const privateKey = githubAppPrivateKey();
  if (!appId || !privateKey) {
    throw new Error('GitHub App is not configured (set KORTIX_GITHUB_APP_ID and KORTIX_GITHUB_APP_PRIVATE_KEY)');
  }

  const now = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  });
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(normalizeGitHubPrivateKey(privateKey)).toString('base64url');
  return `${unsigned}.${signature}`;
}

function requestToken(auth?: Pick<GitHubAuthContext, 'token'>) {
  if (auth?.token) return auth.token;
  throw new Error('GitHub auth is not configured for this request — a GitHub App installation token or a project credential is required');
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
    throw new Error(`GitHub ${path} failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getGitHubAppInstallation(installationId: string): Promise<GitHubAppInstallation> {
  const id = installationId.trim();
  if (!id) throw new Error('installation_id is required');
  return ghFetch<GitHubAppInstallation>(
    `/app/installations/${encodeURIComponent(id)}`,
    { method: 'GET' },
    { token: createGitHubAppJwt() },
  );
}

export async function createInstallationToken(
  installationId: string,
  /**
   * When provided, the minted token is scoped to ONLY these repos (by name,
   * within the installation's owner). Used for managed repos so a project's
   * sandbox gets a least-privilege token that can touch its own repo and no
   * other repo under the managed org.
   */
  repositories?: string[],
): Promise<GitHubInstallationToken> {
  const id = installationId.trim();
  if (!id) throw new Error('installation_id is required');
  const scoped = (repositories ?? []).map((r) => r.trim()).filter(Boolean);
  return ghFetch<GitHubInstallationToken>(
    `/app/installations/${encodeURIComponent(id)}/access_tokens`,
    {
      method: 'POST',
      ...(scoped.length ? { body: JSON.stringify({ repositories: scoped }) } : {}),
    },
    { token: createGitHubAppJwt() },
  );
}

export async function listInstallationRepositories(
  installationId: string,
): Promise<GitHubRepo[]> {
  const token = await createInstallationToken(installationId);
  const perPage = 100;
  const repositories: GitHubRepo[] = [];
  let page = 1;
  let totalCount: number | null = null;

  do {
    const body = await ghFetch<GitHubInstallationRepositories>(
      `/installation/repositories?per_page=${perPage}&page=${page}`,
      { method: 'GET' },
      { token: token.token },
    );
    totalCount = body.total_count;
    const pageRepositories = body.repositories ?? [];
    if (pageRepositories.length === 0) break;
    repositories.push(...pageRepositories);
    page += 1;
  } while (totalCount !== null && repositories.length < totalCount);

  return repositories;
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

async function resolveDefaultOwner(auth?: GitHubAuthContext): Promise<{ owner: string; isOrg: boolean }> {
  if (auth?.owner) {
    return { owner: auth.owner, isOrg: auth.ownerType !== 'User' };
  }

  // App-only: the installation auth context carries the owner. Fall back to
  // the token's authenticated account only if it somehow wasn't provided.
  const me = await ghFetch<{ login: string }>(`/user`, undefined, auth);
  return { owner: me.login, isOrg: false };
}

export async function createRepo(input: CreateRepoInput): Promise<GitHubRepo> {
  const ownerInput = input.owner?.trim();
  if (input.auth?.owner && ownerInput && ownerInput.toLowerCase() !== input.auth.owner.toLowerCase()) {
    throw new Error('GitHub owner must match the account GitHub App installation');
  }

  const target = await resolveDefaultOwner(input.auth);

  const body = {
    name: input.name,
    description: input.description,
    private: input.isPrivate ?? true,
    auto_init: input.autoInit ?? true,
  };

  const path = target.isOrg ? `/orgs/${target.owner}/repos` : '/user/repos';
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
  auth?: GitHubAuthContext;
}): Promise<void> {
  const body: Record<string, unknown> = {
    message: opts.message,
    content: Buffer.from(opts.content, 'utf8').toString('base64'),
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
