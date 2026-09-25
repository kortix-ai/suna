/**
 * The one request path from the SDK to the Kortix backend.
 *
 * `send()` owns everything every backend request must agree on:
 *   - the token: `getToken()` from the configured host, or an explicit token;
 *   - the header policy: bearer, `X-Kortix-Client`, admin read bypass, act-as;
 *   - the default deadline, composed with the caller's signal;
 *   - the one 401 replay with a fresh token, from a copy of the request taken
 *     BEFORE the first send (a `Request` body is consumed by the first send);
 *   - the configured `fetch` (`configureKortix({ fetch })`).
 *
 * It returns the `Response` for any HTTP status. It throws only when no
 * request was sent: `AuthError` without a token, `AbortError` on an abort.
 * The adapters shape that for their callers:
 *   - `backendApi.*` (`api-client.ts`): parsed body or a typed `ApiError`;
 *   - `authenticatedFetch` (`auth.ts`): fetch semantics, a synthetic 401;
 *   - `backendApi.postStream`: the raw streamed `Response`.
 *
 * This module imports no sibling transport module (`auth.ts`,
 * `api-client.ts`), so tests that replace those with `mock.module` do not
 * change what `send` does.
 */

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  normalizeClientSource,
  withDefaultTimeout,
  withTokenRetry,
} from '../../platform/auth-core';
import { abortable, createAbortError } from './abort';
import { AuthError } from './api/errors';
import { platformConfig } from './config';
import { impersonationHeaders } from './impersonation';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SendOptions {
  /** Replay a 401 once with a fresh token from `getToken()`. Default `true`. */
  retryOnAuthError?: boolean;
  /**
   * The transport deadline in ms, composed with the caller's signal. Default
   * `DEFAULT_FETCH_TIMEOUT_MS`; the SSE event stream is exempt. `null`: no
   * transport deadline, the caller's signal is the only one.
   */
  timeoutMs?: number | null;
  /** The bearer for the first send, already resolved by the caller. */
  token?: string;
  /** The `fetch` to send with. Default `configureKortix({ fetch })`, then the global. */
  fetch?: Fetch;
}

// ── Header policy ───────────────────────────────────────────────────────────

// Platform-admin read-only bypass toggle (web only). In-memory, per-tab, never
// persisted, so it resets on reload and cannot linger. While on, every request
// carries `x-kortix-admin-bypass: 1`; the API honors it only for a platform
// admin on a `read` action (apps/api/src/projects/lib/access.ts).
let adminBypassEnabled = false;

export function setAdminBypass(enabled: boolean): void {
  adminBypassEnabled = enabled;
}

export function isAdminBypassEnabled(): boolean {
  return adminBypassEnabled;
}

function toRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

/**
 * The caller's headers plus the platform policy. A caller's own
 * `Authorization` or `X-Kortix-Client` wins. Act-as is attached after the
 * caller's headers so a call site cannot drop it, except on the admin console,
 * which the API never impersonates (see `shouldAttachImpersonation`).
 */
function withPlatformHeaders(url: string, base: Record<string, string>, token: string): Record<string, string> {
  const headers = { ...base };
  const has = (name: string) => Object.keys(headers).some((key) => key.toLowerCase() === name);
  const clientSource = normalizeClientSource(platformConfig().clientSource);
  if (clientSource && !has('x-kortix-client')) headers['X-Kortix-Client'] = clientSource;
  if (adminBypassEnabled) headers['x-kortix-admin-bypass'] = '1';
  Object.assign(headers, impersonationHeaders(url));
  if (!has('authorization')) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// ── Send ────────────────────────────────────────────────────────────────────

/** A `ReadableStream` request body can be read once, so it cannot be resent. */
function hasOneShotBody(init: RequestInit): boolean {
  return typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream;
}

function dispatch(
  fetchImpl: Fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  token: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (input instanceof Request) {
    // The headers go ON the Request: `fetch(Request, { headers })` is dropped
    // by some patched fetches (Next.js) and browsers.
    const base = toRecord(input.headers);
    Object.assign(base, toRecord(init.headers));
    const headers = new Headers(withPlatformHeaders(input.url, base, token));
    return fetchImpl(new Request(input, { headers, ...(signal ? { signal } : {}) }));
  }
  const url = String(input);
  const headers = withPlatformHeaders(url, toRecord(init.headers), token);
  return fetchImpl(url, { ...init, headers, ...(signal ? { signal } : {}) });
}

async function currentToken(options?: { attempts: number; baseDelayMs: number }): Promise<string | null> {
  return withTokenRetry(() => platformConfig().getToken(), options);
}

/** Send one request to the Kortix backend. See the module comment for the contract. */
export async function send(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: SendOptions = {},
): Promise<Response> {
  const { retryOnAuthError = true, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = options;
  const fetchImpl: Fetch = options.fetch ?? platformConfig().fetch ?? fetch;
  const signal =
    timeoutMs === null
      ? ((input instanceof Request ? input.signal : init.signal) ?? undefined)
      : withDefaultTimeout(input, init, timeoutMs);
  if (signal?.aborted) throw createAbortError();

  const token = options.token ?? (await (signal ? abortable(currentToken(), signal) : currentToken()));
  if (!token) throw new AuthError();

  const canRetry = retryOnAuthError && !hasOneShotBody(init);
  const retryInput = canRetry && input instanceof Request ? input.clone() : input;

  const response = await dispatch(fetchImpl, input, init, token, signal);
  if (response.status !== 401 || !canRetry) return response;

  const fresh = await currentToken({ attempts: 2, baseDelayMs: 200 });
  if (!fresh || fresh === token) return response;
  return dispatch(fetchImpl, retryInput, init, fresh, signal);
}
