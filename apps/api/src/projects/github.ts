import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { getTraceHeaders } from '../lib/request-context';
import { resolveAppIdentity } from '../platform/services/github-app-identity';
import { createInstallationTokenCache } from './github-installation-token-cache';

const GITHUB_API = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    /**
     * Seconds GitHub asked the caller to wait, when the failure is a rate
     * limit (primary or secondary). Undefined for every other failure.
     */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * The wait GitHub asks for on a rate-limited response, in seconds, or null
 * when the response is not a rate limit.
 *
 * Order follows GitHub's REST guidance
 * (docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api):
 * `retry-after` first; then `x-ratelimit-reset` when `x-ratelimit-remaining`
 * is 0; otherwise a secondary rate limit waits at least one minute.
 */
export function githubRetryAfterSeconds(
  status: number,
  responseHeaders: Headers,
  message: string,
  nowMs: number = Date.now(),
): number | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = Number(responseHeaders.get('retry-after'));
  if (responseHeaders.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.ceil(retryAfter);
  }
  if (responseHeaders.get('x-ratelimit-remaining') === '0') {
    const reset = Number(responseHeaders.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - nowMs / 1000));
  }
  if (status === 429 || /rate limit/i.test(message)) return 60;
  return null;
}

/**
 * The GitHub App (scope `app`) or one installation of it (scope
 * `installation`) lacks a permission a Kortix flow depends on. It is an
 * operator or organization-owner fault, never the caller's: keep it apart from
 * "the caller is not an admin" so the UI does not blame the wrong party.
 */
export class GitHubAppPermissionError extends Error {
  constructor(
    message: string,
    readonly scope: 'app' | 'installation',
    readonly missing: string[],
  ) {
    super(message);
    this.name = 'GitHubAppPermissionError';
  }
}

/**
 * The organization restricts access by IP address (GitHub Enterprise Cloud) and
 * refused a request from this API's egress address. The caller's role is not
 * the cause. An organization owner resolves it: enable "IP allow list
 * configuration for installed GitHub Apps", which imports the addresses the
 * App owner published on the App, or add those addresses by hand.
 */
export class GitHubIpAllowListError extends Error {
  constructor(readonly organization: string) {
    super(
      `${organization} restricts GitHub access with an IP allow list, and it blocked Kortix. ` +
        `An owner of ${organization} must enable "IP allow list configuration for installed GitHub Apps" ` +
        '(organization Settings → Authentication security), then verify again.',
    );
    this.name = 'GitHubIpAllowListError';
  }
}

/**
 * The organization enforces SAML single sign-on and the caller authorized
 * Kortix without an active SSO session for it, so GitHub refuses the user
 * token for that organization. The caller resolves it: sign in to the
 * organization through its SSO in the same browser, then verify again.
 */
export class GitHubSamlSsoError extends Error {
  constructor(readonly organization: string) {
    super(
      `${organization} enforces SAML single sign-on. Open https://github.com/orgs/${organization}/sso ` +
        'in this browser, sign in, then verify again.',
    );
    this.name = 'GitHubSamlSsoError';
  }
}

/** GitHub's 403 body for a request an organization IP allow list refused. */
export function isGitHubIpAllowListRefusal(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 403 && /IP allow list/i.test(error.message);
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
const slugCache = new Map<
  string,
  { slug: string | null; permissions: Record<string, string> | null; at: number; ttl: number }
>();
const slugMismatchLogged = new Set<string>();
const permissionDriftLogged = new Set<string>();

/**
 * Every permission a Kortix flow reads or writes through the App. The
 * self-host manifest (platform/routes/github-app.ts) requests exactly this
 * set, and `resolveGitHubAppPermissions()` compares a hand-made App against it.
 *
 * - `administration: write` — `createRepo` under a connected organization.
 * - `contents: write` — commits and pushes.
 *
 * `pull_requests` is NOT here: no API route calls a pulls endpoint and no GitHub
 * token reaches a sandbox (git goes through the Kortix git proxy). The manifest
 * still requests it (`GITHUB_APP_MANIFEST_PERMISSIONS`) so a future pulls flow
 * needs no re-consent, but its absence breaks nothing and must not alarm.
 * - `members: read` — the account-linking identity proof
 *   (`verifyGitHubInstallationAdmin`, `listLinkableGitHubAppInstallations`).
 *   GitHub answers 403 on both membership reads without it.
 */
export const REQUIRED_GITHUB_APP_PERMISSIONS = {
  administration: 'write',
  contents: 'write',
  metadata: 'read',
  members: 'read',
} as const satisfies Record<string, 'read' | 'write'>;

/** What the self-host manifest requests: the required set plus reserved extras. */
export const GITHUB_APP_MANIFEST_PERMISSIONS = {
  ...REQUIRED_GITHUB_APP_PERMISSIONS,
  pull_requests: 'write',
} as const satisfies Record<string, 'read' | 'write'>;

const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

function missingGitHubAppPermissions(granted: Record<string, unknown> | null | undefined): string[] {
  return Object.entries(REQUIRED_GITHUB_APP_PERMISSIONS)
    .filter(([name, level]) => {
      const have = PERMISSION_RANK[String(granted?.[name] ?? '')] ?? 0;
      return have < PERMISSION_RANK[level];
    })
    .map(([name]) => name)
    .sort();
}

export interface ResolvedGitHubAppSlug {
  slug: string | null;
  source: 'derived' | 'configured' | 'none';
}

/** Test-only: drop the per-appId slug cache. */
export function resetGitHubAppSlugCache(): void {
  slugCache.clear();
  slugMismatchLogged.clear();
  permissionDriftLogged.clear();
}

/** One cached `GET /app` per appId backs both the slug and the permissions. */
async function readGitHubApp(identity: { appId: string }) {
  const cached = slugCache.get(identity.appId);
  if (cached && Date.now() - cached.at < cached.ttl) return cached;

  try {
    const app = await ghFetch<{ slug?: string; permissions?: Record<string, string> }>(
      '/app',
      { method: 'GET' },
      { token: createGitHubAppJwt() },
    );
    const entry = {
      slug: typeof app.slug === 'string' && app.slug.trim() ? app.slug.trim() : null,
      permissions: app.permissions && typeof app.permissions === 'object' ? app.permissions : null,
      at: Date.now(),
      ttl: SLUG_TTL_MS,
    };
    slugCache.set(identity.appId, entry);

    const missing = entry.permissions ? missingGitHubAppPermissions(entry.permissions) : [];
    if (missing.length && !permissionDriftLogged.has(identity.appId)) {
      permissionDriftLogged.add(identity.appId);
      console.error(
        `[github-app] App "${entry.slug ?? identity.appId}" is missing required permissions: ` +
          `${missing.join(', ')}. Flows that depend on them fail for every user. ` +
          'Add them in the App settings (Permissions & events).',
      );
    }
    return entry;
  } catch (err) {
    const entry = { slug: null, permissions: null, at: Date.now(), ttl: SLUG_FAILURE_TTL_MS };
    slugCache.set(identity.appId, entry);
    console.warn(
      `[github-app] could not derive the App slug from GET /app for appId ${identity.appId}:`,
      err instanceof Error ? err.message : err,
    );
    return entry;
  }
}

export interface ResolvedGitHubAppPermissions {
  /** `null` when no App is configured or `GET /app` failed. */
  permissions: Record<string, string> | null;
  /** Names from `REQUIRED_GITHUB_APP_PERMISSIONS` the App lacks. Empty when unknown. */
  missing: string[];
}

export async function resolveGitHubAppPermissions(): Promise<ResolvedGitHubAppPermissions> {
  const identity = resolveAppIdentity();
  if (!identity) return { permissions: null, missing: [] };
  const { permissions } = await readGitHubApp(identity);
  return { permissions, missing: permissions ? missingGitHubAppPermissions(permissions) : [] };
}

export async function resolveGitHubAppSlug(): Promise<ResolvedGitHubAppSlug> {
  const identity = resolveAppIdentity();
  if (!identity) return { slug: null, source: 'none' };

  const derived = (await readGitHubApp(identity)).slug;

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
      githubRetryAfterSeconds(res.status, res.headers, detail) ?? undefined,
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
    // Organization installations drop out of the list below. Say why once:
    // `resolveGitHubAppPermissions()` logs a missing `members` permission.
    const app = await resolveGitHubAppPermissions();
    console.warn(
      `[github-app] GET /user/memberships/orgs returned 403 for ${githubLogin}; ` +
        `organization installations are omitted (App missing: ${app.missing.join(', ') || 'none'})`,
    );
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

/**
 * Status for a failed `verifyGitHubInstallationAdmin`. An App without the
 * permission is an instance fault (502, same as the other upstream-GitHub
 * failures on these routes); everything else is the caller's access (403).
 */
export function githubVerificationStatus(error: unknown): 403 | 502 {
  return error instanceof GitHubAppPermissionError && error.scope === 'app' ? 502 : 403;
}

async function membersPermissionError(
  installation: GitHubAppInstallation,
): Promise<GitHubAppPermissionError> {
  const owner = installation.account?.login?.trim() ?? 'this organization';
  const app = await resolveGitHubAppPermissions();
  if (app.missing.includes('members')) {
    console.error(
      `[github-app] cannot verify organization installation ${installation.id} (${owner}): ` +
        'the App has no "Members: read" organization permission',
    );
    return new GitHubAppPermissionError(
      'This Kortix instance cannot verify GitHub organizations: its GitHub App is missing the ' +
        '"Members: read" organization permission. Your GitHub role is not the cause. ' +
        'Contact the instance operator.',
      'app',
      ['members'],
    );
  }
  const where = installation.html_url ? ` at ${installation.html_url}` : ' in its GitHub App settings';
  return new GitHubAppPermissionError(
    `${owner} has not granted the Kortix GitHub App the "Members: read" permission. ` +
      `An owner of ${owner} must accept the updated permissions${where}, then verify again.`,
    'installation',
    ['members'],
  );
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

  // `GET /app/installations/{id}` reports what THIS installation was granted.
  // Without `members`, GitHub answers 403 below for an organization owner too.
  if (installation.permissions && !installation.permissions.members) {
    throw await membersPermissionError(installation);
  }

  let membership: { state?: string; role?: string };
  try {
    membership = await ghFetch<{ state?: string; role?: string }>(
      `/orgs/${encodeURIComponent(ownerLogin)}/memberships/${encodeURIComponent(login)}`,
      { method: 'GET' },
      { token },
    );
  } catch (error) {
    if (isGitHubIpAllowListRefusal(error)) throw new GitHubIpAllowListError(ownerLogin);
    if (error instanceof GitHubApiError && error.status === 403 && /SAML/i.test(error.message)) {
      throw new GitHubSamlSsoError(ownerLogin);
    }
    if (
      error instanceof GitHubApiError &&
      error.status === 403 &&
      error.message.includes('Resource not accessible by integration')
    ) {
      throw await membersPermissionError(installation);
    }
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
  // Keyed by App id too: a stored installation minted under a previous App
  // identity must not be answered from the new identity's cache.
  return installationTokens.get(githubAppId()?.trim() ?? '', id, scoped, (installId, repos) =>
    ghFetch<GitHubInstallationToken>(
      `/app/installations/${encodeURIComponent(installId)}/access_tokens`,
      {
        method: 'POST',
        ...(repos.length ? { body: JSON.stringify({ repositories: repos }) } : {}),
      },
      { token: createGitHubAppJwt() },
    ),
  );
}

const installationTokens = createInstallationTokenCache();

/** Drop cached tokens of one installation (after an uninstall or a 401). */
export function invalidateInstallationTokens(installationId: string) {
  installationTokens.invalidate(installationId.trim());
}

/** Test seam: forget every cached installation token. */
export function clearInstallationTokenCacheForTests() {
  installationTokens.clear();
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
