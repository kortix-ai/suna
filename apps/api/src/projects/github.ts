import { createSign } from 'node:crypto';
import { getTraceHeaders } from '../lib/request-context';

const GITHUB_API = 'https://api.github.com';

export type GitHubAuthSource = 'app_installation' | 'pat';

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

function patToken() {
  return process.env.KORTIX_GITHUB_TOKEN || process.env.GITHUB_TOKEN || null;
}

function githubAppId() {
  return process.env.KORTIX_GITHUB_APP_ID || process.env.GITHUB_APP_ID || null;
}

function githubAppPrivateKey() {
  return process.env.KORTIX_GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY || null;
}

export function githubAppSlug() {
  return process.env.KORTIX_GITHUB_APP_SLUG || process.env.GITHUB_APP_SLUG || null;
}

export function isGithubPatConfigured() {
  return Boolean(patToken());
}

export function isGithubAppConfigured() {
  return Boolean(githubAppId() && githubAppPrivateKey());
}

export function buildGitHubAppInstallUrl(accountId?: string | null) {
  const slug = githubAppSlug()?.trim();
  if (!slug) return null;
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  if (accountId) url.searchParams.set('state', accountId);
  return url.toString();
}

export function normalizeGitHubPrivateKey(value: string) {
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
  const token = patToken();
  if (!token) {
    throw new Error('GitHub auth is not configured for this request');
  }
  return token;
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

export async function createInstallationToken(installationId: string): Promise<GitHubInstallationToken> {
  const id = installationId.trim();
  if (!id) throw new Error('installation_id is required');
  return ghFetch<GitHubInstallationToken>(
    `/app/installations/${encodeURIComponent(id)}/access_tokens`,
    { method: 'POST' },
    { token: createGitHubAppJwt() },
  );
}

async function resolveDefaultOwner(auth?: GitHubAuthContext): Promise<{ owner: string; isOrg: boolean }> {
  if (auth?.owner) {
    return { owner: auth.owner, isOrg: auth.ownerType !== 'User' };
  }

  const envOwner = process.env.KORTIX_GITHUB_OWNER?.trim();
  if (envOwner) {
    try {
      await ghFetch<{ login: string; type?: string }>(`/orgs/${envOwner}`, undefined, auth);
      return { owner: envOwner, isOrg: true };
    } catch {
      return { owner: envOwner, isOrg: false };
    }
  }
  const me = await ghFetch<{ login: string }>(`/user`, undefined, auth);
  return { owner: me.login, isOrg: false };
}

export async function createRepo(input: CreateRepoInput): Promise<GitHubRepo> {
  const ownerInput = input.owner?.trim();
  if (input.auth?.owner && ownerInput && ownerInput.toLowerCase() !== input.auth.owner.toLowerCase()) {
    throw new Error('GitHub owner must match the account GitHub App installation');
  }

  const target = ownerInput && !input.auth?.owner
    ? await (async () => {
        try {
          await ghFetch(`/orgs/${ownerInput}`, undefined, input.auth);
          return { owner: ownerInput, isOrg: true };
        } catch {
          return { owner: ownerInput, isOrg: false };
        }
      })()
    : await resolveDefaultOwner(input.auth);

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
