import { backendApi } from '@kortix/sdk';

import type { Auth } from './auth.ts';
import { secureRemoteBase } from './config.ts';
import { withKortixScope } from './sdk.ts';
import { rememberTokenIdentity } from './token-identity.ts';
import type { MeResponse } from './types.ts';

// Re-exported for callers/tests that reach it via the client module.
export { secureRemoteBase };

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

/** Normalize an incoming CLI path to the SDK-relative endpoint. The SDK's
 *  `backendUrl` already carries the `/v1` mount (see `sdkBackendUrl`), so a
 *  caller that passed `/v1/...` must have it stripped or the request would hit
 *  `/v1/v1/...` and 404 with a valid token. */
function toEndpoint(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return p.startsWith('/v1/') ? p.slice(3) : p;
}

/** Append `account_id=<id>` to an endpoint, merging with any existing query,
 *  but never duplicating a param the caller already set explicitly. */
function withAccountId(endpoint: string, accountId?: string): string {
  if (!accountId) return endpoint;
  if (/[?&]account_id=/.test(endpoint)) return endpoint;
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}account_id=${encodeURIComponent(accountId)}`;
}

/** The CLI's calls are interactive and some are genuinely long (provision, a
 *  session create that waits on a snapshot). The SDK's own default is 30s,
 *  which the CLI never had — keep the generous ceiling so nothing that worked
 *  before starts aborting mid-flight. */
const CLI_REQUEST_TIMEOUT_MS = 600_000;

/** Translate the SDK's `ApiResponse` envelope into the CLI's throw-on-error
 *  `ApiError`, preserving `.status` — commands branch on 402/404/409/5xx.
 *
 *  `status` is read structurally, not via `instanceof SdkApiError`: the SDK
 *  reclassifies some responses into sibling types that extend `Error` directly
 *  (`BillingError` for a 402, `RequestTooLargeError` for a 431). Duck-typing
 *  `.status` keeps every one of them mapped to the right exit path instead of
 *  collapsing a 402 into a generic status-0 failure. */
function unwrap<T>(res: { data?: T; error?: unknown; success: boolean }): T {
  if (res.success) return res.data as T;
  const err = res.error;
  if (err instanceof Error) {
    const carrier = err as Error & { status?: unknown; details?: unknown; data?: unknown };
    const status = typeof carrier.status === 'number' ? carrier.status : 0;
    const body = carrier.details ?? carrier.data ?? null;
    throw new ApiError(status, err.message, body);
  }
  throw new ApiError(0, String(err ?? 'request failed'));
}

/** Is this the identity endpoint, with or without a query string? */
function isMeEndpoint(endpoint: string): boolean {
  return endpoint === '/accounts/me' || endpoint.startsWith('/accounts/me?');
}

/**
 * Capture WHO the acting token is from any `/accounts/me` response.
 *
 * Every command that already fetches identity (whoami, projects, accounts,
 * login, doctor, ship, the cross-host session scan) warms the token-identity
 * cache here, so the host line can name the agent a sandbox token was minted
 * for without ever adding a request of its own. Never throws: a cache write is
 * never a reason to fail the call that produced the data.
 */
function captureIdentity(endpoint: string, token: string, data: unknown): void {
  if (!isMeEndpoint(endpoint) || !token || !data || typeof data !== 'object') return;
  try {
    rememberTokenIdentity(token, data as MeResponse);
  } catch {
    /* best effort */
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  opts: { auth: Auth; accountId?: string },
): Promise<T> {
  const endpoint = withAccountId(toEndpoint(path), opts.accountId);
  const options = { showErrors: false as const, timeout: CLI_REQUEST_TIMEOUT_MS };
  return withKortixScope(opts.auth, async () => {
    switch (method) {
      case 'GET': {
        const data = unwrap<T>(await backendApi.get<T>(endpoint, options));
        captureIdentity(endpoint, opts.auth.token, data);
        return data;
      }
      case 'POST':
        return unwrap<T>(await backendApi.post<T>(endpoint, body, options));
      case 'PUT':
        return unwrap<T>(await backendApi.put<T>(endpoint, body, options));
      case 'PATCH':
        return unwrap<T>(await backendApi.patch<T>(endpoint, body, options));
      case 'DELETE':
        return unwrap<T>(await backendApi.delete<T>(endpoint, options));
    }
  });
}

export function createApiClient(opts: ClientOptions): ApiClient {
  const apiBase = opts.apiBase ?? 'https://api.kortix.com';
  const accountId = opts.accountId || undefined;
  // The SDK config seam is keyed on an `Auth`; a bare `createApiClient` caller
  // only supplies a base + token, so synthesize the identity-free rest.
  const auth: Auth = {
    api_base: apiBase,
    token: opts.token ?? '',
    user_id: '',
    user_email: '',
    account_id: accountId ?? '',
    logged_in_at: '',
  };
  const base = { auth, accountId };
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
