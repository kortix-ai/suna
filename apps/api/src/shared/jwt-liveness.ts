/**
 * Bounded, short-lived cache of "GoTrue confirmed this access token's session
 * is live".
 *
 * ─── Why (2026-09-23) ───────────────────────────────────────────────────────
 * Prod Supabase signs access tokens with the legacy HS256 secret. The local
 * JWKS verifier cannot check a symmetric token, so every authenticated request
 * paid one `GET /auth/v1/user` round trip to GoTrue before the handler ran —
 * a page load fires 10–20 parallel API calls, each with its own GoTrue call.
 *
 * `jwt-verify.ts` now checks an HS256 token's signature and expiry locally with
 * `SUPABASE_JWT_SECRET`. What local verification cannot see is REVOCATION:
 * sign-out, a deleted or banned user, a GoTrue-side session revoke. GoTrue's
 * `getUser` does see it, so it stays in the loop — but at most once per token
 * per `SUPABASE_JWT_LIVENESS_TTL_MS` (default 0: no cache) per replica.
 *
 * 2026-10-01: the ES256 (JWKS) path in `jwt-verify.ts` confirms liveness here
 * too. Before, an ES256 token survived logout, a ban or a deleted user until
 * `exp`.
 *
 * Security contract (explicit):
 *  - Only a POSITIVE GoTrue answer is cached. A rejection or a GoTrue failure is
 *    never cached, so the next request asks again.
 *  - An entry never outlives the token's own `exp`.
 *  - For immediate cross-replica logout, production must keep TTL at zero.
 *    `POST /v1/auth/logout` drops the local entry as well.
 *  - TTL 0 disables the cache: every request asks GoTrue (the old behavior).
 *  - Keys are SHA-256 digests of the token; the raw token is never stored.
 *  - Bounded to MAX_ENTRIES; the oldest entry is evicted first.
 *
 * Kept apart from `jwt-verify.ts` because five test files replace that module
 * wholesale; the logout route imports `forgetJwtLiveness` from here.
 */

import { createHash } from 'node:crypto';
import { config } from '../config';
import { getSupabase } from './supabase';

export interface LiveUser {
  id: string;
  email: string;
}

interface Entry {
  user: LiveUser;
  expiresAt: number;
}

const MAX_ENTRIES = 10_000;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<LiveUser | null>>();

/** Loader seam for tests; production asks GoTrue. */
type Loader = (token: string) => Promise<LiveUser | null>;

async function askGoTrue(token: string): Promise<LiveUser | null> {
  const {
    data: { user },
    error,
  } = await getSupabase().auth.getUser(token);
  if (error) {
    // A 4xx is GoTrue's verdict on the token (revoked, deleted, bad JWT). Any
    // other failure is GoTrue being unreachable: surface it as an error so the
    // caller fails closed without recording a verdict.
    const status = (error as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) return null;
    throw error;
  }
  if (!user) return null;
  return { id: user.id, email: user.email ?? '' };
}

let loader: Loader = askGoTrue;
let invalidationVersion = 0;

function keyFor(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ttlMs(): number {
  const ttl = Number(config.SUPABASE_JWT_LIVENESS_TTL_MS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

async function loadStableUser(token: string): Promise<LiveUser | null> {
  for (;;) {
    const version = invalidationVersion;
    const user = await loader(token);
    if (version === invalidationVersion) return user;
  }
}

/**
 * The live user behind `token`, or null when GoTrue says the session is gone.
 * Throws when GoTrue cannot be reached. `expSeconds` is the verified `exp`
 * claim; the cached answer never outlives it.
 */
export async function confirmJwtLive(token: string, expSeconds: number | undefined): Promise<LiveUser | null> {
  const ttl = ttlMs();
  if (ttl === 0) return loadStableUser(token);

  const key = keyFor(token);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > now) return hit.user;
    cache.delete(key);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = loadStableUser(token)
    .then((user) => {
      if (user) {
        const tokenExpiry = typeof expSeconds === 'number' ? expSeconds * 1000 : Number.POSITIVE_INFINITY;
        const expiresAt = Math.min(Date.now() + ttl, tokenExpiry);
        if (expiresAt > Date.now()) {
          if (cache.size >= MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(key, { user, expiresAt });
        }
      }
      return user;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Drop the cached confirmation for `token` (sign-out on this replica). */
export function forgetJwtLiveness(token: string): void {
  cache.delete(keyFor(token));
}

/** Drop every token for a deleted user on this replica. TTL 0 is required across replicas. */
export function forgetUserJwtLiveness(userId: string): void {
  invalidationVersion++;
  for (const [key, entry] of cache) {
    if (entry.user.id === userId) cache.delete(key);
  }
  inflight.clear();
}

/** Test seam: replace the GoTrue loader and clear all state. */
export function __setJwtLivenessLoaderForTests(next: Loader | null): void {
  loader = next ?? askGoTrue;
  cache.clear();
  inflight.clear();
}

/** Current entry count (tests and diagnostics). */
export function jwtLivenessCacheSize(): number {
  return cache.size;
}
