import type { Auth } from './auth.ts';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ApiClient {
  apiBase: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

export interface ClientOptions {
  apiBase?: string;
  token?: string;
  /** When set (non-empty), every request is scoped to this account via a
   *  `?account_id=` query param. The API honors it in resolveProjectAccount
   *  (and validates membership); project-id routes ignore it. Without it the
   *  server falls back to the caller's earliest-joined account. */
  accountId?: string;
}

function joinUrl(base: string, path: string): string {
  let b = base.endsWith('/') ? base.slice(0, -1) : base;
  // The base may or may not already carry the `/v1` mount. Host login stores a
  // bare origin (`https://api.kortix.com`); a session sandbox injects
  // `KORTIX_API_URL` *with* the suffix (`https://<tunnel>/v1`). Strip a trailing
  // `/v1` here so we add exactly one below — otherwise in-sandbox calls hit
  // `/v1/v1/projects/…` and 404 even with a valid token.
  if (b.endsWith('/v1')) b = b.slice(0, -3);
  const p = path.startsWith('/') ? path : `/${path}`;
  // Hono mounts v1 routes. Normalize incoming `/accounts/me` -> `/v1/accounts/me`.
  const versioned = p.startsWith('/v1/') ? p : `/v1${p}`;
  return `${b}${versioned}`;
}

/** Append `account_id=<id>` to a URL, merging with any existing query, but
 *  never duplicating a param the caller already set explicitly. */
function withAccountId(url: string, accountId?: string): string {
  if (!accountId) return url;
  if (/[?&]account_id=/.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}account_id=${encodeURIComponent(accountId)}`;
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  opts: { apiBase: string; token?: string; accountId?: string },
): Promise<T> {
  const url = withAccountId(joinUrl(opts.apiBase, path), opts.accountId);
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, `network error: ${(err as Error).message}`);
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof payload === 'object' && payload && 'error' in payload && typeof (payload as { error: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : typeof payload === 'object' && payload && 'message' in payload && typeof (payload as { message: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, payload);
  }

  return payload as T;
}

export function createApiClient(opts: ClientOptions): ApiClient {
  const apiBase = opts.apiBase ?? 'https://api.kortix.com';
  const accountId = opts.accountId || undefined;
  const base = { apiBase, token: opts.token, accountId };
  return {
    apiBase,
    get: <T>(path: string) => request<T>('GET', path, undefined, base),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}, base),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}, base),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}, base),
    delete: <T>(path: string) => request<T>('DELETE', path, undefined, base),
  };
}

export interface ClientFromAuthOptions {
  /** Scope every request to this account via `?account_id=`. Opt-in: pass it
   *  only for account-scoped LISTs (e.g. `projects ls`). Project-id routes
   *  (`/projects/<id>/…`) already determine the account from the id, and
   *  identity calls (`/accounts/me`) must stay account-agnostic — leave it
   *  unset for those. */
  accountId?: string;
}

export function clientFromAuth(auth: Auth, opts: ClientFromAuthOptions = {}): ApiClient {
  return createApiClient({
    apiBase: auth.api_base,
    token: auth.token,
    accountId: opts.accountId || undefined,
  });
}
