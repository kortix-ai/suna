'use client';

/**
 * The two lists every host opens on: the caller's accounts, and one account's
 * projects.
 *
 * Both already had a client function (`listAccounts`, `listProjectsForAccount`)
 * and a key (`qk.accounts.list`, `qk.projects.list`) — and no hook, so every
 * host rewrote the `useQuery` wiring: `apps/web/src/hooks/account/use-accounts-list.ts`
 * (thirteen hand-typed copies before it), the workspace switcher, the command
 * palette, and now `apps/tui/src/features/sidebar/sidebar.tsx` with a key of
 * its own invention (`['tui', 'accounts', host, url]`) that shares nothing with
 * the rest of the cache. `staleTime` is per-OBSERVER in React Query, so a
 * fetcher, a key and a gate that are copied rather than shared drift silently:
 * "N readers, one request" quietly becomes N requests.
 *
 * ## Identity is an argument, not an assumption
 *
 * `qk.accounts.list(userId)` takes the user id ON PURPOSE. `['accounts']` is
 * the same array for every user, so one document that saw two users held ONE
 * entry for both — and `/new` resolves its create target out of that list, so a
 * leftover list belonging to the previous user made `POST /projects/provision`
 * go out with a foreign `account_id` under the new user's JWT (403).
 *
 * The SDK core is framework-free and cannot see a host's auth context, so the
 * host passes `userId`. A multi-user host (a browser document that can switch
 * users without a reload) MUST pass it. A single-identity host — a CLI or TUI
 * process that holds one token for its whole lifetime — may omit it and share
 * the one anonymous slot, because there is no second user to bleed into.
 */

import { useQuery } from '@tanstack/react-query';
import {
  listAccounts,
  listProjectsForAccount,
  type KortixAccount,
  type KortixProject,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

export type AccountsKey = ReturnType<typeof qk.accounts.list>;
export type ProjectsKey = ReturnType<typeof qk.projects.list>;

/**
 * The key + gate + freshness contract `useAccounts` reads, without React.
 *
 * Split out from the hook so the three things that MUST agree across every
 * caller can be asserted directly — this package has no React test renderer,
 * and a source-text assertion cannot tell a working gate from a deleted one.
 */
export function accountsQueryOptions(userId?: string | null, enabled = true) {
  return {
    queryKey: qk.accounts.list(userId),
    enabled,
    ...contract('inventory'),
  };
}

/** The same, for one account's project list. See {@link accountsQueryOptions}. */
export function projectsQueryOptions(accountId?: string, enabled = true) {
  return {
    queryKey: qk.projects.list(accountId),
    enabled,
    ...contract('inventory'),
  };
}

export interface UseAccountsOptions {
  /**
   * The signed-in user's id. Part of the cache key, so two users can never
   * share one entry. Required in any host where the user can change without a
   * reload; omit it only in a single-identity process (CLI/TUI).
   */
  userId?: string | null;
  /**
   * The caller's own gate — "only while this panel is open". ANDed with
   * nothing else: a surface being open says nothing about identity, so a
   * multi-user host still has to pass `userId`.
   */
  enabled?: boolean;
}

/** `GET /accounts` — every account the caller belongs to. */
export function useAccounts(options: UseAccountsOptions = {}) {
  return useQuery<KortixAccount[]>({
    ...accountsQueryOptions(options.userId, options.enabled ?? true),
    queryFn: listAccounts,
  });
}

export interface UseProjectsOptions {
  enabled?: boolean;
}

/**
 * `GET /projects[?account_id=…]` — one account's projects.
 *
 * Omitting `accountId` is NOT "every project": the API resolves an unscoped
 * read to ONE default account server-side (`resolveProjectAccount`). That is
 * why `qk.projects.list()` and `qk.projects.list(accountId)` are siblings in
 * the key factory rather than a parent and a child, and why a host that wants
 * every account's projects issues one query per account.
 */
export function useProjects(accountId?: string, options: UseProjectsOptions = {}) {
  return useQuery<KortixProject[]>({
    ...projectsQueryOptions(accountId, options.enabled ?? true),
    queryFn: () => listProjectsForAccount(accountId),
  });
}
