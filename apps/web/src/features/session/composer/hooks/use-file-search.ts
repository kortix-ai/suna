'use client';

import { useEffect, useRef } from 'react';

import { searchWorkspaceFiles } from '@/features/files';
import { qk, runtimeKeys, useActiveSandboxProxyContext } from '@kortix/sdk/react';
import type { QueryKey } from '@tanstack/react-query';
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
 * Task 9, fix round 1: the set of cache-key prefixes `useMenuRevalidation`
 * invalidates on the `@`/`/` menu's open transition. Extracted as its own
 * pure function — same reasoning as `isMenuOpenTransition` above — so the
 * key SELECTION is directly testable, not just asserted by code review.
 *
 * Commands has exactly ONE query-key shape: `useOpenCodeCommands`
 * (`use-opencode-sessions/commands.ts`) never branches, so the bare
 * `['opencode', 'commands']` prefix always reaches it.
 *
 * Agents does NOT have one shape. `useOpenCodeAgents`
 * (`use-opencode-sessions/agents.ts:42-46`) branches on `projectId`:
 *
 * ```ts
 * queryKey: projectId
 *   ? [...qk.project.detail(projectId), 'agents']   // ['kx','project',<id>,'detail','agents']
 *   : directory
 *     ? [...opencodeKeys.agents(), 'dir', directory] // ['opencode','agents',<server>,'dir',<dir>]
 *     : opencodeKeys.agents()                        // ['opencode','agents',<server>]
 * ```
 *
 * The bare `['opencode', 'agents']` prefix (`runtimeKeys.agents()` minus its
 * trailing server segment) DOES reach the `directory` and no-argument
 * branches — both start with `opencodeKeys.agents()`, so it's a genuine
 * prefix of both. It is DISJOINT AT SEGMENT 0 from the `projectId` branch's
 * `['kx', 'project', ...]` shape — no amount of prefix-matching bridges
 * `'opencode'` and `'kx'`. Every real composer call site passes `projectId`
 * (`instant-session-shell.tsx:88`, `composer-chat-input.tsx:108`,
 * `session-chat.tsx:1641`), so invalidating only the bare prefix was a
 * SILENT no-op for agents in every actual composer — commands and skills
 * refreshed, agents did not, and nothing about `invalidateQueries` failing
 * to match anything ever surfaces an error.
 *
 * Fixed by also invalidating the exact nested key
 * `[...qk.project.detail(projectId), 'agents']` whenever a `projectId` is
 * known — not the broader `qk.project.detail(projectId)` prefix itself,
 * which would ALSO refetch the (heavier) project detail payload and touch
 * every other `detail(id)` consumer (`useProjectConfig`, the model picker,
 * ...), not just agents. Built through the public `qk` (`@kortix/sdk/react`)
 * the exact same way `agents.ts` itself builds it, not a hand-typed
 * `['kx', 'project', ...]` literal — see `use-file-search.test.ts` for the
 * test that binds this to `qk.project.detail` directly, so a future
 * reshuffle of `useOpenCodeAgents`'s branching can't repeat this silently.
 */
export function menuRevalidationKeys(projectId?: string | null): QueryKey[] {
  const keys: QueryKey[] = [
    runtimeKeys.agents().slice(0, -1),
    runtimeKeys.commands().slice(0, -1),
  ];
  if (projectId) {
    keys.push([...qk.project.detail(projectId), 'agents']);
  }
  return keys;
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
 * across both — see `composer-editor.tsx`'s `onMenuOpenChange`) and the
 * active `projectId` (`composer.tsx`'s own prop — the same value every
 * composer call site already passes to `useRuntimeAgents`), and on the
 * closed->open transition it invalidates every cache-key shape
 * `menuRevalidationKeys` names, so a skill, agent, or command created after
 * page load is in the list the next time either menu opens, without a full
 * reload.
 *
 * This fires 2 `invalidateQueries` calls with no `projectId` (agents,
 * commands) and 3 with one (agents, commands, project-scoped agents) — MORE
 * calls than a naive read of "invalidate the agents cache" suggests, and
 * that is correct: `menuRevalidationKeys`'s own doc comment is the reason
 * why one key alone cannot reach every branch `useOpenCodeAgents` can take.
 */
export function useMenuRevalidation(isOpen: boolean, projectId?: string | null): void {
  const queryClient = useQueryClient();
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isMenuOpenTransition(wasOpenRef.current, isOpen)) {
      for (const queryKey of menuRevalidationKeys(projectId)) {
        queryClient.invalidateQueries({ queryKey });
      }
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, projectId, queryClient]);
}
