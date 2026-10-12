/**
 * The registry of memos keyed `${userId}|…`, which
 * `invalidateIamCacheForUser` (iam/cache-invalidation.ts) busts per principal.
 *
 * It lives in the shared layer so that a shared module (the preview proxy's
 * ownership cache) can register without importing the IAM services layer.
 * Process-local: each API replica busts its own in-memory caches.
 */
export interface PrincipalScopedMemo {
  invalidateByPrefix: (prefix: string) => void;
}

export const principalScopedMemos: PrincipalScopedMemo[] = [];

/** A memo keyed `${userId}|…` registers so it can be busted per principal. */
export function registerPrincipalScopedMemo(memo: PrincipalScopedMemo): void {
  principalScopedMemos.push(memo);
}
