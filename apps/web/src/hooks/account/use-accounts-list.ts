/**
 * The account list — `listAccounts()`, `GET /accounts` — read through ONE
 * user-scoped cache entry.
 *
 * ## Why this hook exists
 *
 * Thirteen components used to hand-type the identical four lines:
 *
 * ```ts
 * useQuery({ queryKey: ['accounts'], queryFn: listAccounts, staleTime: 60_000 })
 * ```
 *
 * Two things were wrong with that, and only one of them was cosmetic.
 *
 * **1. The key carried no identity.** `['accounts']` is the same array for
 * every user, so one document that saw two users held ONE entry for both. The
 * only thing separating user B from user A's list was an imperative
 * `queryClient.clear()` on the sign-out path — which has to fire on every
 * exit, finish before anything refetches, never be undone, and which leaves
 * mounted observers attached so they immediately refetch anyway.
 *
 * That gap was not theoretical. `/new` resolves its create target out of this
 * list (`resolveTargetAccountId`, `new-workspace-form.ts`), so a leftover
 * single-account list belonging to the previous user made
 * `POST /projects/provision` go out with a foreign `account_id` under the new
 * user's JWT, which the API answers 403. It could not be closed by inspecting
 * the list: a legitimate invited admin — no personal account, administers
 * someone else's org — produces a byte-identical single foreign
 * `KortixAccount`, and rejecting that shape would lock that population out of
 * creating any workspace. Only the KEY distinguishes them, which is what
 * `qk.accounts.list(userId)` adds.
 *
 * **2. Eight of the thirteen had no `enabled` gate.** They fired before
 * `useAuth()` had resolved and wrote whatever came back into the shared slot.
 * Every reader now fails CLOSED: no user id, no query, no data — never
 * another user's data.
 *
 * ## Why one hook rather than thirteen corrected copies
 *
 * `staleTime` is per-observer in React Query, and the key, the fetcher and the
 * gate all have to agree across every caller or the "13 readers, one request"
 * property silently becomes "13 requests". Thirteen hand-written copies is how
 * the original drift happened. There is one definition here, and
 * `apps/web/eslint.config.mjs` makes a reintroduced `queryKey: ['accounts']`
 * a build failure.
 *
 * The KEY itself is not defined here — it comes from `qk` in `@kortix/sdk/react`,
 * which is the source of truth for every Kortix cache key. This hook only binds
 * it to the host's own auth context, which the framework-free SDK cannot see.
 */

import { useAuth } from '@/features/providers/auth-provider';
import { listAccounts, type KortixAccount } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

/**
 * The one freshness contract for the account list. Exported so the value is a
 * single constant rather than thirteen copies of the number `60_000`, which is
 * exactly how per-observer `staleTime` drifted apart before.
 */
export const ACCOUNTS_STALE_TIME = 60_000;

export type AccountsListQueryKey = ReturnType<typeof qk.accounts.list>;

export interface UseAccountsListOptions {
  /**
   * The caller's own gate — "only while this modal is open". ANDed with the
   * identity gate, never a replacement for it: a surface being open says
   * nothing about whether we know who is looking at it.
   */
  enabled?: boolean;
  /**
   * Retry budget. Only `/projects/start` sets one (it resolves a landing
   * destination from this list, so a single transient failure there strands
   * the user on a spinner). Left `undefined` elsewhere so React Query's
   * default applies — passing a value here would be a behaviour change, not a
   * key change.
   */
  retry?: number;
}

/**
 * The query options every reader shares, with identity already folded in.
 *
 * Split out from the hook so the gate and the key can be asserted directly,
 * without a React renderer — `apps/web` has no React test harness, and a
 * source-text assertion would not be able to tell a working gate from a
 * deleted one.
 */
export function accountsListQueryOptions(
  userId: string | null | undefined,
  enabled = true,
): { queryKey: AccountsListQueryKey; enabled: boolean; staleTime: number } {
  return {
    queryKey: qk.accounts.list(userId),
    // Fail closed (G2). `!!userId` is the whole point: the key alone stops a
    // reader SEEING another user's entry, and this stops it WRITING into a
    // slot before we know whose slot it is.
    enabled: !!userId && enabled,
    staleTime: ACCOUNTS_STALE_TIME,
  };
}

/**
 * The exact cache key `useAccountsList` reads, for the two `setQueryData`
 * writers that seed a newly created account into the list.
 *
 * Those writers must never construct the key themselves — a writer and a
 * reader on different keys is silent: the create appears to succeed and the
 * list never changes. Invalidation is a different job and uses
 * `qk.accounts.scope()` instead; see the note on that member.
 */
export function useAccountsQueryKey(): AccountsListQueryKey {
  const { user } = useAuth();
  return qk.accounts.list(user?.id);
}

/**
 * The account list for the signed-in user. Returns `undefined` data — never
 * another user's list — until identity is known.
 */
export function useAccountsList(
  options: UseAccountsListOptions = {},
): UseQueryResult<KortixAccount[]> {
  const { user } = useAuth();
  return useQuery({
    ...accountsListQueryOptions(user?.id, options.enabled),
    queryFn: listAccounts,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
}
