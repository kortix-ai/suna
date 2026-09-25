/**
 * The one request path from the SDK to the Kortix backend.
 *
 * `send()` owns everything every backend request must agree on:
 *   - the token: `getToken()` from the configured host, resolved on every
 *     send, so a retry after a 401 replay starts from the fresh token. There
 *     is no token option: the 401 replay asks `getToken()` again, so a
 *     caller-resolved token would be swapped for the host's identity;
 *   - the header policy: bearer, `X-Kortix-Client`, admin read bypass, act-as;
 *   - the default deadline, composed with the caller's signal;
 *   - the one 401 replay with a fresh token, from a copy of the request taken
 *     BEFORE the first send (a `Request` body is consumed by the first send).
 *     A caller that sets its own `Authorization` gets no replay: a fresh host
 *     token cannot change a header the caller owns;
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

// The headers of one request, as a plain record: the wire shape a URL request
// has always carried, with the names as the caller spelled them. Header names
// are case-insensitive, as in `Headers`: `setHeader` replaces a name in any
// case, so no name goes out twice with two values joined.

function entriesOf(headers: HeadersInit | undefined): Array<[string, string]> {
  if (!headers) return [];
  if (headers instanceof Headers || Array.isArray(headers)) return [...new Headers(headers).entries()];
  return Object.entries(headers);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key];
  headers[name] = value;
}

/** The caller's headers: the `Request`'s own, then `init.headers` over them. */
function callerHeaders(input: RequestInfo | URL, init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  const sources = [input instanceof Request ? input.headers : undefined, init.headers];
  for (const [name, value] of sources.flatMap(entriesOf)) setHeader(headers, name, value);
  return headers;
}

/**
 * The caller's headers plus the platform policy. A caller's own
 * `Authorization` or `X-Kortix-Client` wins. Admin bypass and act-as replace
 * the caller's value, so a call site cannot drop them; the admin console is
 * never impersonated (see `shouldAttachImpersonation`).
 */
function withPlatformHeaders(url: string, base: Record<string, string>, token: string): Record<string, string> {
  const headers = { ...base };
  const clientSource = normalizeClientSource(platformConfig().clientSource);
  if (clientSource && !hasHeader(headers, 'x-kortix-client')) setHeader(headers, 'X-Kortix-Client', clientSource);
  if (adminBypassEnabled) setHeader(headers, 'x-kortix-admin-bypass', '1');
  for (const [name, value] of Object.entries(impersonationHeaders(url))) setHeader(headers, name, value);
  if (!hasHeader(headers, 'authorization')) setHeader(headers, 'Authorization', `Bearer ${token}`);
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
    const headers = new Headers(withPlatformHeaders(input.url, callerHeaders(input, init), token));
    return fetchImpl(new Request(input, { headers, ...(signal ? { signal } : {}) }));
  }
  const url = String(input);
  const headers = withPlatformHeaders(url, callerHeaders(input, init), token);
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

  const token = await (signal ? abortable(currentToken(), signal) : currentToken());
  if (!token) throw new AuthError();

  const canRetry =
    retryOnAuthError && !hasOneShotBody(init) && !hasHeader(callerHeaders(input, init), 'authorization');
  const retryInput = canRetry && input instanceof Request ? input.clone() : input;

  const response = await dispatch(fetchImpl, input, init, token, signal);
  if (response.status !== 401 || !canRetry) return response;

  const fresh = await currentToken({ attempts: 2, baseDelayMs: 200 });
  if (!fresh || fresh === token) return response;
  return dispatch(fetchImpl, retryInput, init, fresh, signal);
}
