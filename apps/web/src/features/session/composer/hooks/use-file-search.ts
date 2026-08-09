'use client';

import { useEffect, useRef } from 'react';

import { searchWorkspaceFiles } from '@/features/files';
import { runtimeKeys, useActiveSandboxProxyContext } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

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

/**
 * The pure decision at the heart of `useMenuRevalidation`, below: given the
 * previous and current "is a `@`/`/` menu open" signal, should this render
 * trigger a cache revalidation? Extracted and tested on its own — per this
 * project's discipline (see `canKeepPlaceholderFiles` above,
 * `trackEmptyBoundary` in `editor/composer-editor.tsx`) — because the hook
 * itself calls `useQueryClient().invalidateQueries`, which needs a real
 * `QueryClientProvider` and isn't directly exercisable in this repo's
 * DOM-free `bun test` (see `composer-editor.test.ts`'s file header for the
 * same constraint).
 *
 * `true` on, and only on, the false->true transition — never on every
 * render while the menu stays open, and never on close. Revalidating per
 * keystroke would undo Task 8's work removing a 3x-per-keystroke render
 * storm; revalidating on close buys nothing (the menu is already gone) and
 * would double the invalidation traffic for free.
 */
export function isMenuOpenTransition(wasOpen: boolean, isOpen: boolean): boolean {
  return isOpen && !wasOpen;
}

/**
 * Task 9. The user's own words: "we should get the latest updated skills
 * and files whenever we type @. We need proper caching also, some level of
 * caching and revalidation, like query revalidate."
 *
 * `useRuntimeAgents`/`useRuntimeCommands` (`@kortix/sdk/react`, backed by
 * `packages/sdk/src/react/use-opencode-sessions/{agents,commands}.ts`) both
 * set `staleTime: Infinity` — correct for the SDK's other consumers, which
 * have no equivalent of "the user is about to pick from this list right
 * now" to hang a refetch off of, so `packages/sdk` is deliberately left
 * untouched (zero diff) rather than lowering that value for every
 * downstream install. This hook is the host-side revalidation Infinity
 * asks for: call it with whether the `@`/`/` menu is currently open (OR'd
 * across both — see `composer-editor.tsx`'s `onMenuOpenChange`), and on the
 * closed->open transition it invalidates both caches so a skill, agent, or
 * command created after page load is in the list the next time either menu
 * opens, without a full reload.
 *
 * Invalidates by the two-segment PREFIX (`['opencode', 'agents']` /
 * `['opencode', 'commands']`), not the full three-segment key `runtimeKeys`
 * itself returns (`[..., activeServerKey()]`) — `invalidateQueries` prefix-
 * matches by default, so the shorter key reaches every sandbox's cache
 * entry, not just whichever one happens to be active this render. Derived
 * from the real `runtimeKeys.agents()`/`.commands()` (public API,
 * `use-opencode-sessions/keys.ts:128,135`) by dropping the trailing
 * server-scope segment, rather than a hand-copied literal — so a rename of
 * the leading `'opencode'`/`'agents'`/`'commands'` segments (which would be
 * a breaking SDK change under that package's own naming rules, and thus
 * rare) still can't drift silently out of step with this file. An
 * `invalidateQueries` call against a key that no longer matches anything
 * fails with no error and no warning — it just leaves the menus stale
 * forever — which is exactly why this reads the key from the SDK instead of
 * re-typing the strings.
 */
export function useMenuRevalidation(isOpen: boolean): void {
  const queryClient = useQueryClient();
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isMenuOpenTransition(wasOpenRef.current, isOpen)) {
      queryClient.invalidateQueries({ queryKey: runtimeKeys.agents().slice(0, -1) });
      queryClient.invalidateQueries({ queryKey: runtimeKeys.commands().slice(0, -1) });
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, queryClient]);
}
