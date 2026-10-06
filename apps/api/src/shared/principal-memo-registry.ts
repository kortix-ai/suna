/**
 * The registry half of `iam/cache-invalidation.ts`: memos keyed `${userId}|…`
 * register here so a revoke can bust them per principal. It lives in the
 * shared layer so a shared module (`preview-ownership.ts`) registers its cache
 * without importing the services layer. Process-local, like the memos.
 */

export interface PrincipalScopedMemo {
  invalidateByPrefix: (prefix: string) => void;
}

const principalScopedMemos: PrincipalScopedMemo[] = [];

/** A memo keyed `${userId}|…` registers so it can be busted per principal. */
export function registerPrincipalScopedMemo(memo: PrincipalScopedMemo): void {
  principalScopedMemos.push(memo);
}

/** Every registered principal-scoped memo, in registration order. */
export function principalScopedMemoList(): readonly PrincipalScopedMemo[] {
  return principalScopedMemos;
}
