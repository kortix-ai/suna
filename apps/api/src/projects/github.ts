import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { getTraceHeaders } from '../lib/request-context';
import { resolveAppIdentity } from '../platform/services/github-app-identity';

const GITHUB_API = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

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

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

interface GitHubInstallationRepositories {
  total_count: number;
  repositories: GitHubRepo[];
}

interface GitHubRepositorySearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepo[];
}

interface RepositoryListOptions {
  owner?: string;
  ownerType?: 'User' | 'Organization';
  search?: string;
  limit?: number;
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

interface GitHubOrganizationMembership {
  state?: string;
  role?: string;
  organization?: {
    login?: string;
  };
}

export interface CreateRepoInput {
  name: string;
  isPrivate?: boolean;
  description?: string;
  autoInit?: boolean;
  owner?: string;
  auth?: GitHubAuthContext;
}

// The App identity is resolved WHOLE from one source — env or the
// `github_app_identity` platform setting — by
// platform/services/github-app-identity.ts. These accessors never mix the two
// field by field: one stored row shadowing six env values is the 2026-09-16
// production incident.
export function githubAppId() {
  return resolveAppIdentity()?.appId ?? null;
}

function githubAppPrivateKey() {
  return resolveAppIdentity()?.privateKey ?? null;
}

/**
 * The slug an operator configured, on whichever source owns the identity.
 * It is a FALLBACK: `resolveGitHubAppSlug()` derives the live slug from
 * `GET /app` and only reads this when derivation fails. Production ran for
 * months with `KORTIX_GITHUB_APP_SLUG=kortix-private-repo-access` while the
 * App's real slug was `kortix-managed`, so every install URL 404ed.
 */
export function configuredGitHubAppSlug() {
  return resolveAppIdentity()?.configuredSlug ?? null;
}

export function isGithubAppConfigured() {
  return resolveAppIdentity() !== null;
}

// The App's own OAuth client (every GitHub App gets one for "user access
// token" / user-to-server flows) — used to prove a caller's GitHub identity
// and org role for account-linking (see platform/routes/github-app.ts's
// oauth/authorize + oauth/callback).
export function githubAppClientId() {
  return resolveAppIdentity()?.clientId ?? null;
}

export function githubAppClientSecret() {
  return resolveAppIdentity()?.clientSecret ?? null;
}

/** Whether the App's own OAuth identity-proof flow (oauth/authorize +
 *  oauth/callback) can run. This is independent of `isGithubAppConfigured()`
 *  (App ID + private key, needed for JWT/installation calls) — a deployment
 *  can have one without the other, e.g. an App pasted via POST /app with no
 *  client credentials supplied. */
export function isGithubAppOAuthConfigured() {
  return Boolean(githubAppClientId() && githubAppClientSecret());
}

/**
 * The HMAC key behind the install-state token. The identity's own state
 * secret first; `SUPABASE_JWT_SECRET` and the private key are last-resort
 * signing keys for a deployment that never set one. They are signing keys,
 * not identity fields, so reading them here is not a mixed identity.
 */
export function githubAppStateSecret() {
  const identity = resolveAppIdentity();
  return (
    identity?.stateSecret ||
    process.env.KORTIX_GITHUB_APP_STATE_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    identity?.privateKey ||
    null
  );
}

// ─── Slug derivation ─────────────────────────────────────────────────────────
// The slug is a PROPERTY of the App, so it is read from the App: `GET /app`
// signed with the identity's own JWT. A configured slug is only consulted when
// that read fails, and a mismatch between the two is logged once.

const SLUG_TTL_MS = 60 * 60 * 1000;
const SLUG_FAILURE_TTL_MS = 60 * 1000;
const slugCache = new Map<string, { slug: string | null; at: number; ttl: number }>();
const slugMismatchLogged = new Set<string>();

export interface ResolvedGitHubAppSlug {
  slug: string | null;
  source: 'derived' | 'configured' | 'none';
}

/** Test-only: drop the per-appId slug cache. */
export function resetGitHubAppSlugCache(): void {
  slugCache.clear();
  slugMismatchLogged.clear();
}

export async function resolveGitHubAppSlug(): Promise<ResolvedGitHubAppSlug> {
  const identity = resolveAppIdentity();
  if (!identity) return { slug: null, source: 'none' };

  const cached = slugCache.get(identity.appId);
  const fresh = cached && Date.now() - cached.at < cached.ttl;
  let derived = fresh ? cached.slug : null;

  if (!fresh) {
    try {
      const app = await ghFetch<{ slug?: string }>(
        '/app',
        { method: 'GET' },
        { token: createGitHubAppJwt() },
      );
      derived = typeof app.slug === 'string' && app.slug.trim() ? app.slug.trim() : null;
      slugCache.set(identity.appId, { slug: derived, at: Date.now(), ttl: SLUG_TTL_MS });
    } catch (err) {
      derived = null;
      slugCache.set(identity.appId, { slug: null, at: Date.now(), ttl: SLUG_FAILURE_TTL_MS });
      console.warn(
        `[github-app] could not derive the App slug from GET /app for appId ${identity.appId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (derived) {
    const configured = identity.configuredSlug;
    if (configured && configured !== derived && !slugMismatchLogged.has(identity.appId)) {
      slugMismatchLogged.add(identity.appId);
      console.warn(
        `[github-app] configured slug "${configured}" does not match the App's own slug "${derived}" ` +
          `(appId ${identity.appId}); using the derived one`,
      );
    }
    return { slug: derived, source: 'derived' };
  }

  const configured = identity.configuredSlug;
  if (configured) return { slug: configured, source: 'configured' };
  return { slug: null, source: 'none' };
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
  purpose?: 'account_link' | 'platform_setup';
  frontendOrigin?: string;
  issuedAt: number;
}

export function normalizeGitHubFrontendOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
      return undefined;
    }
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function buildGitHubAppInstallState(
  accountId: string,
  options: {
    nonce?: string;
    purpose?: 'account_link' | 'platform_setup';
    frontendOrigin?: string;
  } = {},
  nowMs = Date.now(),
) {
  const payload = Buffer.from(JSON.stringify({
    account_id: accountId,
    nonce: options.nonce,
    purpose: options.purpose,
    frontend_origin: normalizeGitHubFrontendOrigin(options.frontendOrigin),
    iat: Math.floor(nowMs / 1000),
  })).toString('base64url');
  return `v1.${payload}.${signGitHubAppStatePayload(payload)}`;
}

export function verifyGitHubAppInstallStatePayload(
  state: string | undefined | null,
  nowMs = Date.now(),
): GitHubAppInstallState | null {
  // Defensive against bare/missing `state` query params — the install-callback
  // route (apps/api/src/platform/routes/github-app.ts) calls this with
  // `query.state`, which is `string | undefined` (zod schema marks it
  // `optional()`). Without this guard, `undefined.split('.')` throws a
  // TypeError that surfaces as a 500 on a bare GET /install-callback hit —
  // observed live on staging (ke2e GHA-2). Mirrors verifyManifestStartState's
  // own null-on-non-string-input contract. Every real GitHub redirect always
  // includes a `state` param, so this is a robustness fix, not a security
  // change — a missing state was always meant to be rejected (→ null → 302
  // redirect), just not by crashing.
  if (typeof state !== 'string' || state.length === 0) return null;
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
      purpose?: unknown;
      frontend_origin?: unknown;
      iat?: unknown;
    };
    const accountId = typeof decoded.account_id === 'string' ? decoded.account_id : '';
    const nonce = typeof decoded.nonce === 'string' ? decoded.nonce : undefined;
    const purpose =
      decoded.purpose === 'account_link' || decoded.purpose === 'platform_setup'
        ? decoded.purpose
        : undefined;
    const frontendOrigin = normalizeGitHubFrontendOrigin(decoded.frontend_origin);
    const issuedAt = typeof decoded.iat === 'number' ? decoded.iat : 0;
    const now = Math.floor(nowMs / 1000);
    if (!accountId || issuedAt < now - 30 * 60 || issuedAt > now + 60) return null;
    return { accountId, nonce, purpose, frontendOrigin, issuedAt };
  } catch {
    return null;
  }
}

/**
 * The App's install URL. Never emitted for a slug that was not derived from
 * `GET /app` or explicitly configured — a guessed slug is a permanent 404 on
 * github.com, which is what production served until 2026-09-16.
 */
export async function buildGitHubAppInstallUrl(
  accountId?: string | null,
  nonce?: string,
  purpose: 'account_link' | 'platform_setup' = 'account_link',
  frontendOrigin?: string,
): Promise<string | null> {
  const { slug } = await resolveGitHubAppSlug();
  if (!slug) return null;
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  if (accountId) {
    try {
      url.searchParams.set(
        'state',
        buildGitHubAppInstallState(accountId, { nonce, purpose, frontendOrigin }),
      );
    } catch {
      return null;
    }
  }
  return url.toString();
}

function normalizeGitHubPrivateKey(value: string) {
  // Strip surrounding quotes (a secret stored as "...PEM..." double-encodes the
  // quotes into the value) and \n-escapes, so a quoted secret can never produce
  // OpenSSL NO_START_LINE. Then normalize escaped newlines to real ones.
  return value
    .trim()
    .replace(/^\s*(['"])([\s\S]*)\1\s*$/, '$2')
    .trim()
    .replace(/\\n/g, '\n');
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Sign a GitHub App JWT for an EXPLICIT (appId, privateKey) pair — split out
 * of `createGitHubAppJwt` so the "paste an existing App" setup route
 * (platform/routes/github-app.ts's POST /app) can validate credentials a user
 * just typed in *before* they're stored as the platform's active config
 * (`createGitHubAppJwt` below only ever signs for whatever is ALREADY
 * configured).
 */
export function signGitHubAppJwt(appId: string, privateKey: string, nowMs = Date.now()) {
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

export function createGitHubAppJwt(nowMs = Date.now()) {
  const appId = githubAppId()?.trim();
  const privateKey = githubAppPrivateKey();
  if (!appId || !privateKey) {
    throw new Error('GitHub App is not configured (set KORTIX_GITHUB_APP_ID and KORTIX_GITHUB_APP_PRIVATE_KEY)');
  }
  return signGitHubAppJwt(appId, privateKey, nowMs);
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
    throw new GitHubApiError(
      `GitHub ${path} failed (${res.status}): ${detail || res.statusText}`,
      res.status,
      path,
    );
  }
  return res.json() as Promise<T>;
}

async function ghFetchAllPages<T>(
  path: string,
  auth: Pick<GitHubAuthContext, 'token'>,
): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= 100; page += 1) {
    const pageItems = await ghFetch<T[]>(
      `${path}${separator}per_page=100&page=${page}`,
      { method: 'GET' },
      auth,
    );
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
  throw new Error('GitHub returned more than 10,000 records');
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

export async function listLinkableGitHubAppInstallations(
  userToken: string,
): Promise<{ githubLogin: string; installations: GitHubAppInstallation[] }> {
  const token = userToken.trim();
  if (!token) throw new Error('GitHub authorization is required to list installations');

  let user: { login?: string };
  try {
    user = await ghFetch<{ login?: string }>('/user', { method: 'GET' }, { token });
  } catch {
    throw new Error('GitHub user authorization is invalid or expired');
  }

  const githubLogin = user.login?.trim();
  if (!githubLogin) throw new Error('GitHub did not return the authorized user login');

  const appInstallations = await ghFetchAllPages<GitHubAppInstallation>('/app/installations', {
    token: createGitHubAppJwt(),
  });

  let memberships: GitHubOrganizationMembership[] = [];
  try {
    memberships = await ghFetchAllPages<GitHubOrganizationMembership>(
      '/user/memberships/orgs?state=active',
      { token },
    );
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 403) throw error;
  }

  const adminOrganizations = new Set(
    memberships
      .filter((membership) => membership.state === 'active' && membership.role === 'admin')
      .map((membership) => membership.organization?.login?.trim().toLowerCase())
      .filter((login): login is string => Boolean(login)),
  );
  const normalizedLogin = githubLogin.toLowerCase();
  const installations = appInstallations.filter((installation) => {
    const ownerLogin = installation.account?.login?.trim().toLowerCase();
    if (!ownerLogin) return false;
    const ownerType = installation.account?.type ?? installation.target_type;
    if (ownerType === 'User') return ownerLogin === normalizedLogin;
    return adminOrganizations.has(ownerLogin);
  });

  return { githubLogin, installations };
}

export async function verifyGitHubInstallationAdmin(
  userToken: string,
  installation: GitHubAppInstallation,
): Promise<{ login: string }> {
  const token = userToken.trim();
  if (!token) throw new Error('GitHub authorization is required to link this installation');

  const ownerLogin = installation.account?.login?.trim();
  if (!ownerLogin) throw new Error('GitHub installation did not include an owner account');

  let user: { login?: string };
  try {
    user = await ghFetch<{ login?: string }>('/user', { method: 'GET' }, { token });
  } catch {
    throw new Error('GitHub user authorization is invalid or expired');
  }

  const login = user.login?.trim();
  if (!login) throw new Error('GitHub did not return the authorized user login');

  const ownerType = installation.account?.type ?? installation.target_type;
  if (ownerType === 'User') {
    if (login.toLowerCase() !== ownerLogin.toLowerCase()) {
      throw new Error('The authorized GitHub user does not own this installation');
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
    throw new Error('GitHub organization admin access is required to link this installation');
  }

  if (membership.state !== 'active' || membership.role !== 'admin') {
    throw new Error('GitHub organization admin access is required to link this installation');
  }
  return { login };
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
  options: RepositoryListOptions = {},
): Promise<GitHubRepo[]> {
  const token = await createInstallationToken(installationId);
  const limit = normalizeRepositoryLimit(options.limit);
  const search = options.search?.trim();
  if (search) {
    if (!options.owner) throw new Error('owner is required when searching repositories');
    return searchRepositories({
      owner: options.owner,
      ownerType: options.ownerType ?? 'Organization',
      search,
      limit,
      auth: { token: token.token },
    });
  }

  const body = await ghFetch<GitHubInstallationRepositories>(
    `/installation/repositories?per_page=${limit}&page=1`,
    { method: 'GET' },
    { token: token.token },
  );
  return body.repositories ?? [];
}

/**
 * List repositories for the managed-git PAT backend ("Use a token" self-host
 * setup) — the token equivalent of `listInstallationRepositories`, which only
 * works for a GitHub App installation id. A PAT has no "installation" to
 * enumerate repos from, so this hits the same org-vs-personal-account
 * endpoint `createRepo`/`resolveDefaultOwner` already branch on: an org owner
 * lists via `/orgs/{owner}/repos` (what a fine-grained token scoped to an
 * organization resource-owner can see), a personal owner via `/user/repos`.
 * Empty queries return one recently updated page. Search queries use GitHub's
 * repository search endpoint, scoped to the configured owner.
 * (filtered back down to that owner — a classic token can see collaborator
 * repos under other owners too, which don't belong in "repos for this
 * configured owner").
 */
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

/**
 * Whether a GitHub login is an Organization (vs a personal User). Managed-git
 * was built assuming MANAGED_GIT_GITHUB_OWNER is an org, but a personal account
 * (e.g. a throwaway) needs `/user/repos` not `/orgs/{owner}/repos`. Cached —
 * an account's type doesn't change. Safe default 'org' (historical behavior).
 */
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
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}
