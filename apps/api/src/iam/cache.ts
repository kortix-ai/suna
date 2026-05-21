// Per-request memoisation for authorize() calls. Hono context carries this
// map so that multiple permission checks in the same request collapse to a
// single set of DB lookups per (action, target) key.

import type { Context } from 'hono';
import { authorize, type AuthorizeResult, type AuthorizeTarget } from './engine';

type CacheMap = Map<string, Promise<AuthorizeResult>>;

const CACHE_KEY = '__iamAuthorizeCache' as const;

function cacheKey(action: string, target?: AuthorizeTarget): string {
  if (!target) return `${action}|account|*`;
  return `${action}|${target.type}|${'id' in target && target.id ? target.id : '*'}`;
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
  const key = `${userId}|${accountId}|${cacheKey(action, target)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const inflight = authorize(userId, accountId, action, target);
  cache.set(key, inflight);
  return inflight;
}
