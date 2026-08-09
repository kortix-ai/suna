'use client';

import { searchWorkspaceFiles } from '@/features/files';
import { useActiveSandboxProxyContext } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from './use-debounced-value';

/** Stands in for `serverUrl` before a runtime binds, or on self-hosted local
 *  dev's billing-disabled default. `searchWorkspaceFiles` collapses that same
 *  case onto its own single `''` cache bucket (`workspaceIndexCaches.get('')`
 *  in workspace-search-service.ts) — this sentinel just gives the query key a
 *  readable label for the same bucket instead of a bare empty string. */
const UNBOUND_SERVER = 'unbound';

/**
 * Local to apps/web on purpose. `qk` lives in `packages/sdk`, which is
 * published to npm and gates every export on a snapshot test — a host-only
 * mention cache does not belong in that contract.
 *
 * `server` is the discriminator that keeps this cache from bleeding across
 * sandboxes. TanStack's cache is process-wide, but `searchWorkspaceFiles`
 * itself is not scoped by composer — it resolves whatever sandbox is
 * currently active (`getRuntimeCacheKey()` → `getActiveOpenCodeUrl()`) at
 * call time. Two composers both searching "config" on different sandboxes
 * must land in different cache entries, and a composer that stays mounted
 * across a session switch must stop reusing its pre-switch entry the moment
 * the active sandbox changes — `server` is what makes both true.
 */
export const composerFileSearchKey = (server: string, query: string) =>
  ['web', 'composer', 'file-search', server, query] as const;

/** Index of `server` inside `composerFileSearchKey`'s tuple. Named rather than
 *  inlined so the coupling between the key shape and the placeholder guard
 *  below is a single, testable fact instead of a magic `3`. */
const SERVER_KEY_INDEX = 3;

/**
 * Whether a previous query's results may still be shown as placeholder data.
 *
 * `keepPreviousData` alone answers "yes" for ANY previous query, including one
 * that ran against a DIFFERENT sandbox. A composer stays mounted across a
 * session switch (session-chat.tsx pre-mounts every open tab), so switching
 * runtime changes `server`, invalidates the key, and TanStack would hand the
 * `@` menu the OLD sandbox's file list with `isLoading: false` — files that do
 * not exist in the workspace the user is now in, presented as if they do.
 * Selecting one produces a `<file_ref>` for a path the agent cannot resolve.
 * Restricting the placeholder to the same `server` keeps the
 * never-flash-empty behaviour while a query is merely being retyped, and drops
 * it exactly when the workspace underneath changed.
 */
export function canKeepPlaceholderFiles(
  server: string,
  previousQueryKey: readonly unknown[] | undefined,
): boolean {
  return previousQueryKey?.[SERVER_KEY_INDEX] === server;
}

/**
 * File results for the `@` menu.
 *
 * Replaces session-chat-input.tsx:602-656 entirely:
 *  - `fileSearchTimer`   → useDebouncedValue on the key
 *  - `fileSearchSeq`     → the query key itself; a stale response resolves
 *                          under its own key and is never applied to a newer one
 *  - `fileResultsCache`  → keepPreviousData + a 30s staleTime, shared
 *                          process-wide instead of per-composer, scoped by
 *                          `server` so that sharing never crosses a sandbox
 */
export function useFileSearch(query: string, enabled: boolean) {
  const debounced = useDebouncedValue(query, 150);

  // Reactive on purpose, not a bare `getRuntimeCacheKey()` call. That function
  // reads ambient state once per render; a composer that stays mounted in a
  // hidden tab (see use-composer-focus.ts) would only re-read it when
  // something else happens to re-render the component. `getActiveServerUrl()`
  // has the identical gap — it wraps the same read with no subscription of
  // its own (see use-opencode-events/index.ts, which pairs it with
  // `useCurrentRuntime` for exactly this reason). `useActiveSandboxProxyContext`
  // is the SDK's reactive form: it re-renders on every `setCurrentRuntime`
  // (session switch), so `server` and the sandbox `searchWorkspaceFiles`
  // actually calls never drift apart.
  const { serverUrl } = useActiveSandboxProxyContext();
  const server = serverUrl || UNBOUND_SERVER;

  const { data, isFetching } = useQuery({
    queryKey: composerFileSearchKey(server, debounced),
    queryFn: () => searchWorkspaceFiles(debounced),
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    // `keepPreviousData` (the stock helper) is deliberately NOT used — see
    // `canKeepPlaceholderFiles`. This is otherwise the same behaviour: show
    // the last query's rows while the next one is in flight so the `@` menu
    // never flashes empty mid-word, but only while the sandbox underneath is
    // the same one. Written inline rather than hoisted to a stable reference
    // on purpose: query-core reuses the PREVIOUS placeholder result without
    // re-consulting this function whenever the `placeholderData` option is
    // referentially unchanged (`queryObserver.js`'s
    // `prevResult?.isPlaceholderData && options.placeholderData ===
    // prevResultOptions?.placeholderData` short-circuit), which would let a
    // cross-sandbox result survive the very switch this guards against.
    placeholderData: (previous: string[] | undefined, previousQuery) =>
      canKeepPlaceholderFiles(server, previousQuery?.queryKey) ? previous : undefined,
    retry: false,
  });

  return { files: data ?? [], isLoading: isFetching && !data };
}
