/**
 * Platinum API client (our own Cloud Hypervisor microVM sandbox platform).
 *
 * Thin fetch wrapper — Platinum is a plain REST API (Bearer pt_live_… key),
 * so unlike Daytona there's no SDK. Every call goes through platinumJson()
 * which adds auth + base URL and surfaces non-2xx as errors with the body.
 */

import { config } from '../config';

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
const DEFAULT_CALL_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.KORTIX_PLATINUM_CALL_TIMEOUT_MS || '20000', 10) || 20000,
);

async function platinumFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.PLATINUM_API_KEY) throw new Error('Missing PLATINUM_API_KEY');
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
      throw new Error(`platinum ${init.method ?? 'GET'} ${path} timed out after ${DEFAULT_CALL_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

/** GET/POST JSON. Throws `platinum <method> <path> -> <status> <body>` on non-2xx. */
export async function platinumJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await platinumFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}
