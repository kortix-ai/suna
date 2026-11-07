import { ApiError as SdkApiError, backendApi } from '@kortix/sdk';
import { WORKSPACE_ACCOUNT_FAMILIES } from '@kortix/shared/workspace-routes';

import type { Auth } from './auth.ts';
import { secureRemoteBase } from './config.ts';
import { withKortixScope } from './sdk.ts';
import { rememberTokenIdentity, type AccountsMeBody } from './token-identity.ts';

// Re-exported for callers/tests that reach it via the client module.
export { secureRemoteBase };

/** The credential a failed request carried — what `ApiError.credential`
 *  holds. Defined once here so token-denial.ts can type the record without
 *  widening the field. */
export interface ApiErrorCredential {
  host: string;
  token: string;
}

/** The SDK's `ApiError` with the CLI's `(status, message, body)` constructor:
 *  `err instanceof ApiError` from the SDK recognises it too. */
export class ApiError extends SdkApiError {
  declare status: number;
  body: unknown;
  /** The credential the failed request carried — host + token, memory only,
   *  attached NON-enumerable by `requestOnce` so no logger, spread or
   *  JSON dump can carry the secret. The denial footer (token-denial.ts)
   *  resolves the refused identity from it: the active host's identity is a
   *  DIFFERENT credential (inside a sandbox, the injected session token), and
   *  naming that sent the customer looking at the wrong token row. */
  credential?: ApiErrorCredential;
  constructor(status: number, message: string, body: unknown = null) {
    super(message, { status, details: body });
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
  signal?: AbortSignal;
}

/** Normalize an incoming CLI path to the SDK-relative endpoint. The SDK's
 *  `backendUrl` already carries the `/v1` mount (see `sdkBackendUrl`), so a
 *  caller that passed `/v1/...` must have it stripped or the request would hit
 *  `/v1/v1/...` and 404 with a valid token. */
function toEndpoint(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  refuseDotSegments(p);
  return p.startsWith('/v1/') ? p.slice(3) : p;
}

/** A path segment `.` or `..`, also percent-encoded (`%2e`). */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Refuse a request path with a `.` or `..` segment (CWE-22). The URL parser
 * resolves them before the request leaves this process, so an id such as
 * `..` or `x/../../secrets/K` in `/projects/<p>/sessions/<s>/reminders/<id>`
 * would reach another endpoint. `encodeURIComponent` keeps `/` inside one
 * segment, but leaves `.` and `..` as they are: this check covers every
 * command, including one that forgets to encode.
 */
function refuseDotSegments(path: string): void {
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  if (pathname.split('/').some((segment) => DOT_SEGMENT.test(segment))) {
    throw new ApiError(0, `Refused the request path ${pathname}: a "." or ".." segment would send it to another endpoint. Pass ids exactly as Kortix prints them.`);
  }
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

/** A DELETE (`sessions rm`, `projects rm`, …) is a short, bounded control-plane
 *  op — it never long-polls like `provision`/`create`. The 600s ceiling above
 *  let a single STALLED DELETE ride far past any caller's contract window:
 *  incident-20260922T210537Z had a `sessions rm` hang >120s and leave the child
 *  session running, while a fresh retry deleted it in ~1.1s. A per-attempt DELETE
 *  deadline lets a stalled attempt abort well inside that window; the SDK then
 *  replays it (safe — the session delete is an idempotent soft-tombstone), so
 *  3 attempts at this budget stay under a 120s wall while a transient stall
 *  self-heals. Env-tunable for an operator who needs a different budget. */
const CLI_DELETE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.KORTIX_CLI_DELETE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000;
})();

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
  throw cliError(res.error);
}

function cliError(err: unknown): ApiError {
  if (err instanceof Error) {
    const carrier = err as Error & { status?: unknown; details?: unknown; data?: unknown };
    const status = typeof carrier.status === 'number' ? carrier.status : 0;
    const body = carrier.details ?? carrier.data ?? null;
    return new ApiError(status, err.message, body);
  }
  return new ApiError(0, String(err ?? 'request failed'));
}

/** Non-enumerable: the field rides the error object in memory only, and
 *  never reaches a log line, a spread or a JSON dump. */
function attachCredential(err: ApiError, auth: Auth): ApiError {
  if (auth.token) {
    Object.defineProperty(err, 'credential', {
      value: { host: auth.api_base, token: auth.token },
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return err;
}

/** Run an SDK call as `auth` and fail with the CLI's `ApiError`, as an `ApiClient` request does: `surfaceApiError` words a 401, 403 or 5xx from `status`. */
export async function withCliErrors<T>(auth: Auth, fn: () => Promise<T>): Promise<T> {
  try {
    return await withKortixScope(auth, fn);
  } catch (err) {
    throw attachCredential(cliError(err), auth);
  }
}

/** Is this the identity endpoint (`/me`, or its legacy name `/accounts/me`), with or without a query string? */
function isMeEndpoint(endpoint: string): boolean {
  return /^\/(?:accounts\/)?me(?:\?|$)/.test(endpoint);
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
    rememberTokenIdentity(token, data as AccountsMeBody);
  } catch {
    /* best effort */
  }
}

/** The API commits manifest writes (kortix.yaml, agent .md) with a
 *  compare-and-swap on the file sha. Two writes in quick succession — e.g.
 *  `agents default` then `agents scope`, or a dashboard edit landing while the
 *  CLI reads — answer 409 with this exact message. The write is safe to replay:
 *  the server re-reads the file and applies the same mutation on top of the new
 *  sha. Replay ONCE after a short pause; a second conflict is surfaced as-is. */
const MANIFEST_CAS_CONFLICT = /changed since it was read/i;
const MANIFEST_CAS_RETRY_DELAY_MS = 1500;
function isManifestCasConflict(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  if (MANIFEST_CAS_CONFLICT.test(err.message)) return true;
  // The SDK may keep the server's wording in the body rather than the message.
  try {
    return MANIFEST_CAS_CONFLICT.test(JSON.stringify(err.body ?? ''));
  } catch {
    return false;
  }
}

const ACCOUNT_FAMILY_PATH = new RegExp(
  `^(/v1)?/workspaces/([^/?#]+)/(${WORKSPACE_ACCOUNT_FAMILIES.map((f) => f.replace(/[-]/g, '\\-')).join('|')})(?=[/?#]|$)`,
);

/**
 * The legacy twin of a workspace-level path (`/workspaces/<id>/<family>…` →
 * `/accounts/<id>/<family>…`), or null. The CLI builds those paths from the
 * workspace context, whose id is an account id when it came from the older
 * `--account` flag, the older active account or the stored credential. The
 * canonical name takes a workspace id only (404 `workspace_not_found` for an
 * account id); `/v1/accounts/:id/<family>` takes either id, permanently.
 */
export function accountFamilyTwin(path: string): string | null {
  const m = ACCOUNT_FAMILY_PATH.exec(path);
  return m ? `${m[1] ?? ''}/accounts/${path.slice(`${m[1] ?? ''}/workspaces/`.length)}` : null;
}

function isWorkspaceNotFound(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 404) return false;
  const body = err.body as { code?: unknown } | null;
  return body?.code === 'workspace_not_found';
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  opts: { auth: Auth; accountId?: string; signal?: AbortSignal },
): Promise<T> {
  try {
    return await requestOnce<T>(method, path, body, opts);
  } catch (err) {
    const twin = isWorkspaceNotFound(err) ? accountFamilyTwin(path) : null;
    if (twin) return requestOnce<T>(method, twin, body, opts);
    if (method === 'GET' || !isManifestCasConflict(err)) throw err;
    await new Promise((r) => setTimeout(r, MANIFEST_CAS_RETRY_DELAY_MS));
    return requestOnce<T>(method, path, body, opts);
  }
}

async function requestOnce<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  opts: { auth: Auth; accountId?: string; signal?: AbortSignal },
): Promise<T> {
  try {
    const endpoint = withAccountId(toEndpoint(path), opts.accountId);
    const options = { showErrors: false as const, timeout: CLI_REQUEST_TIMEOUT_MS, signal: opts.signal, deadlineCoversBody: Boolean(opts.signal) };
    return await withKortixScope(opts.auth, async () => {
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
          // Bounded per-attempt deadline (not the 600s ceiling) so a stalled
          // delete aborts inside the caller's contract window and the SDK replays
          // it. See CLI_DELETE_TIMEOUT_MS.
          return unwrap<T>(
            await backendApi.delete<T>(endpoint, {
              ...options,
              timeout: CLI_DELETE_TIMEOUT_MS,
            }),
          );
      }
    });
  } catch (err) {
    if (err instanceof ApiError) attachCredential(err, opts.auth);
    throw err;
  }
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
  const base = { auth, accountId, signal: opts.signal };
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
