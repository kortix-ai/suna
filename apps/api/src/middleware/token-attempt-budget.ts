import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { config } from '../config';
import { requestClientIp } from '../shared/client-ip';
import { isTokenHashCached, isTokenValidated } from '../shared/token-hash';

/**
 * Pre-authentication budget for UNKNOWN Kortix bearer tokens, per client IP.
 *
 * Validating a token this process has never seen costs one scrypt (see
 * shared/token-hash.ts). A token already seen costs nothing, so only the
 * refusals of never-seen tokens count against the caller's address. Once an
 * address exceeds `KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN` such refusals, further
 * never-seen tokens from it are answered 429 before any hashing. Tokens this
 * process already knows keep working from the same address, so a real client
 * behind a shared NAT is not locked out by a neighbour.
 *
 * A repeated token is hashed once and then served from the cache, so it counts
 * at most once per cache lifetime: many sandboxes behind one provider egress
 * address that keep retrying a revoked token do not exhaust the budget. The
 * default (300 per minute) bounds one address to 5 scrypt computations per
 * second on the thread pool.
 */

const WINDOW_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 50_000;

type Window = { count: number; startedAt: number };
const windows = new Map<string, Window>();

function limit(): number {
  const raw = Number(
    (config as { KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN?: unknown }).KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN,
  );
  return Number.isInteger(raw) && raw > 0 ? raw : 300;
}

function current(address: string, now: number): Window | null {
  const window = windows.get(address);
  if (!window) return null;
  if (now - window.startedAt >= WINDOW_MS) {
    windows.delete(address);
    return null;
  }
  return window;
}

function recordRefusal(address: string, now: number): void {
  const window = current(address, now);
  if (window) {
    window.count += 1;
    return;
  }
  if (windows.size >= MAX_TRACKED_ADDRESSES) {
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }
  windows.set(address, { count: 1, startedAt: now });
}

function refusal(retryAfterSeconds: number): HTTPException {
  const body = {
    error: 'rate_limit_exceeded',
    code: 'token_attempt_limit',
    message: 'Too many unrecognised tokens from this address. Retry shortly.',
    retry_after_seconds: retryAfterSeconds,
  };
  return new HTTPException(429, {
    message: 'Too many unrecognised tokens from this address',
    res: new Response(JSON.stringify(body), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
      },
    }),
  });
}

/**
 * Run an auth resolver under the budget. `token` is the credential the request
 * presents; anything that is not a `kortix_` token passes through untouched.
 */
export async function withTokenAttemptBudget<T>(
  c: Context,
  token: string | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!token || !token.startsWith('kortix_') || isTokenHashCached(token)) return run();
  const address = requestClientIp(c);
  const now = Date.now();
  const window = current(address, now);
  if (window && window.count >= limit()) {
    throw refusal(Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000)));
  }
  try {
    return await run();
  } catch (err) {
    // Count a refusal of this token, never a later failure of a request whose
    // token authenticated (it is then in the validated set).
    if (err instanceof HTTPException && err.status === 401 && !isTokenValidated(token)) {
      recordRefusal(address, Date.now());
    }
    throw err;
  }
}

/** The first `kortix_` credential a request presents, in resolver order. */
export function presentedKortixToken(c: Context, cookieName?: string): string | null {
  const authorization = c.req.header('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    const bearer = authorization.slice(7);
    if (bearer.startsWith('kortix_')) return bearer;
  }
  const header = c.req.header('X-Kortix-Token');
  if (header?.startsWith('kortix_')) return header;
  if (cookieName) {
    const cookies = c.req.header('Cookie') ?? '';
    for (const part of cookies.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name !== cookieName) continue;
      try {
        const value = decodeURIComponent(rest.join('='));
        if (value.startsWith('kortix_')) return value;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Test seam. */
export function resetTokenAttemptBudget(): void {
  windows.clear();
}
