/**
 * Platinum API client (our own Cloud Hypervisor microVM sandbox platform).
 *
 * Thin fetch wrapper — Platinum is a plain REST API (Bearer pt_live_… key),
 * so unlike Daytona there's no SDK. Every call goes through platinumJson()
 * which adds auth + base URL and surfaces non-2xx as errors with the body.
 */

import { config } from '../config';
import { configuredTimeoutMs } from './with-timeout';

export function isPlatinumConfigured(): boolean {
  return !!config.PLATINUM_API_KEY;
}

function platinumBase(): string {
  const url = config.PLATINUM_API_URL;
  if (!url) throw new Error('Missing PLATINUM_API_URL');
  return url.replace(/\/+$/, '');
}

// Bare `fetch()` has NO default timeout — a stalled connection to Platinum
// hangs the caller forever, same failure class as the Daytona SDK's 24h axios
// default (see platform/providers/daytona.ts for the full incident writeup).
// Platinum is dev's default sandbox provider, and getStatus()/stop()/start()
// here sit on the exact same reaper hot path, so this is bounded by default.
// A caller that needs a longer/no bound (e.g. a deliberately long-poll) can
// still pass its own `init.signal` — this only fills in a default.
const DEFAULT_CALL_TIMEOUT_MS = configuredTimeoutMs('KORTIX_PLATINUM_CALL_TIMEOUT_MS', 20_000, 1_000);

async function platinumFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.PLATINUM_API_KEY) throw new Error('Missing PLATINUM_API_KEY');
  // Track whether WE picked the timeout budget so the error message below
  // reports the real one instead of always claiming the default — a caller
  // like create() passes its own longer signal (70s, for Platinum's 60s
  // server-side wait_timeout_ms long-poll) and a message claiming "20000ms"
  // there would under-report the real elapsed time and mislead debugging of
  // exactly the incident class this bound exists to make observable.
  const usingDefault = init.signal === undefined;
  const signal = init.signal ?? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS);
  try {
    return await fetch(`${platinumBase()}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${config.PLATINUM_API_KEY}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      const budget = usingDefault ? `${DEFAULT_CALL_TIMEOUT_MS}ms (default)` : 'caller-provided budget';
      throw new Error(`platinum ${init.method ?? 'GET'} ${path} timed out after ${budget}`);
    }
    throw err;
  }
}

/**
 * Expected, transient: Platinum auto-stops idle microVMs natively (see
 * PlatinumProvider) and resumes them CoW on reopen. While a box is in that
 * stopped state, POST /:id/expose (and any port-forwarding op) answers
 * `409 {"error":"sandbox not running","code":"sandbox_not_running"}`. That is
 * the system working as designed — the caller (preview proxy, transcript
 * resolver, lease discoverer) either wakes the box and retries, or surfaces a
 * retryable 503 to the client. It is NOT a 500-worthy error and must NOT page
 * Sentry, so it gets its own typed error that `app.onError` classifies out of
 * `captureException` (mirroring the request-deadline 503 pattern). Every OTHER
 * Platinum failure (4xx/5xx, timeout, bad body) still throws the generic
 * `platinum <method> <path> -> <status> <body>` Error and is captured normally
 * — only this one expected state is special-cased, so unexpected failures stay
 * loud.
 */
export class PlatinumSandboxNotRunningError extends Error {
  constructor(message = 'sandbox is not running') {
    super(message);
    this.name = 'PlatinumSandboxNotRunningError';
  }
}

export function isPlatinumSandboxNotRunningError(err: unknown): boolean {
  return err instanceof PlatinumSandboxNotRunningError;
}

// Platinum signals a stopped box with `409 {"code":"sandbox_not_running"}`.
// Match the structured `code` field (not a message substring) so a different
// 409 reason never gets misclassified into the "expected" bucket.
function isSandboxNotRunningBody(status: number, text: string): boolean {
  if (status !== 409) return false;
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    return body.code === 'sandbox_not_running';
  } catch {
    return false;
  }
}

/** GET/POST JSON. Throws `platinum <method> <path> -> <status> <body>` on non-2xx. */
export async function platinumJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await platinumFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    // Expected auto-stopped state → typed error (controlled 503, no Sentry).
    if (isSandboxNotRunningBody(res.status, text)) {
      throw new PlatinumSandboxNotRunningError(
        `platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`,
      );
    }
    throw new Error(`platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}
