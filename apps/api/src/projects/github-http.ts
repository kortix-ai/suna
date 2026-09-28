import { getTraceHeaders } from "../lib/request-context";
export const GITHUB_API = 'https://api.github.com';

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

function requestToken(auth?: Pick<GitHubAuthContext, 'token'>) {
  if (auth?.token) return auth.token;
  throw new Error('GitHub auth is not configured for this request — a GitHub App installation token or a project credential is required');
}

export function headers(auth?: Pick<GitHubAuthContext, 'token'>): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': `Bearer ${requestToken(auth)}`,
    'User-Agent': 'kortix-api',
    'Content-Type': 'application/json',
    ...getTraceHeaders(),
  };
}

export async function ghFetch<T>(
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

export async function ghFetchAllPages<T>(
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
