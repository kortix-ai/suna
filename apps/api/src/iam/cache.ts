// Per-request memoisation for authorize() calls. Hono context carries this
// map so that multiple permission checks in the same request collapse to a
// single set of DB lookups per (action, target) key.

import type { Context } from 'hono';
import { authorize } from './dispatcher';
import type {
  AuthorizeResult,
  AuthorizeTarget,
  RequestContext,
} from './engine';

type CacheMap = Map<string, Promise<AuthorizeResult>>;

const CACHE_KEY = '__iamAuthorizeCache' as const;

function cacheKey(action: string, target?: AuthorizeTarget): string {
  if (!target) return `${action}|account|*`;
  return `${action}|${target.type}|${'id' in target && target.id ? target.id : '*'}`;
}

/**
 * Derive the request context (IP + MFA AAL) from a Hono Context. The IP
 * comes from x-forwarded-for (first hop) or x-real-ip — both set by the
 * upstream proxy. mfaAal is populated by supabaseAuth from the JWT.
 *
 * Folded into the cache key so two requests under the same user but with
 * different IPs / AAL never share an authorize() result — important when
 * policies condition on either.
 */
export function deriveRequestContext(c: Context): RequestContext {
  const xff = c.req.header('x-forwarded-for');
  // First hop in x-forwarded-for is the original client; the rest are
  // intermediate proxies. Trim whitespace because some proxies add it.
  const ip = xff
    ? xff.split(',')[0]?.trim() || undefined
    : c.req.header('x-real-ip') || undefined;
  const mfaAal = c.get('mfaAal') as string | undefined;
  return { ip, mfaAal };
}

export async function authorizeCached(
  c: Context,
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
): Promise<AuthorizeResult> {
  let cache = c.get(CACHE_KEY) as CacheMap | undefined;
  if (!cache) {
    cache = new Map();
    c.set(CACHE_KEY, cache);
  }
  // Token identity is per-request and set by the auth middleware. Include it
  // in the cache key so two concurrent requests under different tokens never
  // share an answer.
  const actingTokenId = c.get('iamTokenId') as string | undefined;
  const ctx = deriveRequestContext(c);
  // Conditions can flip the answer based on IP / AAL, so they belong in
  // the cache key. ip is per-connection so it rarely collides; mfaAal is
  // either 'aal1' or 'aal2'.
  const key = `${userId}|${accountId}|${actingTokenId ?? '-'}|${ctx.ip ?? '-'}|${ctx.mfaAal ?? '-'}|${cacheKey(action, target)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const inflight = authorize(userId, accountId, action, target, actingTokenId, ctx);
  cache.set(key, inflight);
  return inflight;
}
