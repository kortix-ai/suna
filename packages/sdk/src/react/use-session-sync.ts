'use client';

import type { SessionStatus, Todo } from '@opencode-ai/sdk/v2/client';
import { useEffect, useSyncExternalStore } from 'react';
import {
  claimSessionCacheOwnership,
  getSessionCacheOwnership,
  resolveSessionCacheOwnerScope,
  sessionCacheOwnerScopesConflict,
} from '../browser/session-sync/session-cache-ownership';
import {
  getSessionSyncController,
  loadSessionRuntimeStatus,
  loadSessionTranscriptMessages,
  resetSessionSyncControllersForSession,
  retainSessionSyncController,
} from '../browser/session-sync/session-sync-registry';
import {
  readCachedTranscript,
  shouldHydrateFromCache,
  toHydrateEntries,
  writeCachedTranscript,
} from '../browser/session-sync/session-transcript-cache';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { useCurrentRuntime } from './use-current-runtime';
import { canQueryOpenCodeSession } from './use-opencode-sessions';

export { loadSessionRuntimeStatus, loadSessionTranscriptMessages };

type FileDiff = Omit<import('@opencode-ai/sdk/v2/client').SnapshotFileDiff, 'patch'> & {
  patch?: string;
  before?: string;
  after?: string;
};

const EMPTY_DIFFS: FileDiff[] = [];
const EMPTY_TODOS: Todo[] = [];
const IDLE_STATUS = { type: 'idle' } as SessionStatus;

/**
 * Returns the current session tail and explicit history-loading state.
 * Network synchronization lives in the framework-free SessionSyncController.
 */
interface UseSessionSyncOptions {
  /**
   * Stable Kortix `(projectId, sessionId)` scope for disk transcript ownership.
   * This prevents equal OpenCode ids in different sandboxes from sharing data.
   */
  kortixSessionScope?: string;
  /**
   * Allow live REST reconciliation against the current runtime.
   * Set false while `/start` has not switched this Kortix session's sandbox.
   */
  networkEnabled?: boolean;
  /**
   * The caller's working projection (`useSessionWorking`), when it has one.
   *
   * It is the transcript liveness poll's switch. Reading the raw `session.status`
   * slot instead means a dropped busy frame — a backgrounded tab, a proxy
   * reconnect across the start of a turn — leaves the poll off for a turn the
   * server's own authority says is running, and the transcript then never
   * refreshes behind the missing stream. Omit it (apps/mobile) and the stream
   * slot decides, as before.
   */
  working?: boolean;
}

/**
 * Whether the transcript liveness poll should be running. Pure, so "the
 * projection outranks the stream slot" is a test rather than a convention.
 */
export function livenessBusy(input: {
  networkEnabled: boolean;
  runtimeHealthy: boolean;
  working: boolean | undefined;
  streamBusy: boolean;
}): boolean {
  if (!input.networkEnabled || !input.runtimeHealthy) return false;
  return input.working ?? input.streamBusy;
}

export function useSessionSync(sessionId: string, options: UseSessionSyncOptions = {}) {
  const { kortixSessionScope, networkEnabled = true, working } = options;
  const runtimeHealthy = useSandboxConnectionStore((state) => state.healthy === true);
  const runtimeScope = useCurrentRuntime((state) => state.sandboxId) ?? 'none';
  const cacheOwnerScope = resolveSessionCacheOwnerScope(runtimeScope, kortixSessionScope);
  const currentOwner = getSessionCacheOwnership(sessionId);
  const cacheBelongsToAnotherRuntime =
    !!sessionId && sessionCacheOwnerScopesConflict(currentOwner, cacheOwnerScope);
  const readableSessionId = cacheBelongsToAnotherRuntime ? '' : sessionId;
  const controller = getSessionSyncController(sessionId, undefined, runtimeScope);
  const sync = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // Reference-count the mounted consumers of this session's transcript so the
  // store can free it once the last one is gone — without this, every session
  // opened in the tab stays resident for the tab's lifetime.
  //
  // Deliberately NOT folded into the `retainSessionSyncController` call below.
  // That hold is also gated on `networkEnabled` + `runtimeHealthy`, and a
  // session read while its sandbox is still booting is precisely the case the
  // disk paint exists for: eviction there would blank the transcript the user
  // is looking at. Consumers are consumers whether or not the runtime is up.
  useEffect(() => {
    if (!canQueryOpenCodeSession(sessionId)) return;
    return useSyncStore.getState().retainSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!canQueryOpenCodeSession(sessionId) || !cacheOwnerScope) return;
    const claim = claimSessionCacheOwnership(sessionId, cacheOwnerScope);
    if (!sessionCacheOwnerScopesConflict(claim.previousOwnerScope, cacheOwnerScope)) {
      return;
    }
    resetSessionSyncControllersForSession(
      sessionId,
      runtimeScope === 'none' ? undefined : runtimeScope,
    );
    useSyncStore.getState().clearSession(sessionId);
  }, [cacheOwnerScope, runtimeScope, sessionId]);

  // Paint from disk FIRST, and deliberately without waiting on `runtimeHealthy`.
  // The transcript is settled history; gating it on a woken sandbox is what made
  // opening a hibernated session a blank screen for the length of a VM boot.
  // `shouldHydrateFromCache` keeps this strictly additive — the moment the store
  // holds anything for this session, live data owns it and the cache stands down.
  useEffect(() => {
    if (!canQueryOpenCodeSession(sessionId)) return;
    let cancelled = false;
    void (async () => {
      const cached = await readCachedTranscript(sessionId, kortixSessionScope);
      if (cancelled || !cached) return;
      const store = useSyncStore.getState();
      if (
        !shouldHydrateFromCache({
          storeHasSession: sessionId in store.messages,
          storeSessionWasEvicted: store.wasTranscriptEvicted(sessionId),
          cachedMessageCount: cached.messages.length,
        })
      ) {
        return;
      }
      store.hydrate(sessionId, toHydrateEntries(cached));
    })();
    return () => {
      cancelled = true;
    };
  }, [kortixSessionScope, sessionId]);

  useEffect(() => {
    if (
      !networkEnabled ||
      !canQueryOpenCodeSession(sessionId) ||
      !runtimeHealthy ||
      runtimeScope === 'none'
    )
      return;
    resetSessionSyncControllersForSession(sessionId, runtimeScope);
    const release = retainSessionSyncController(sessionId, runtimeScope);
    // Cached messages render immediately. Revalidate one bounded tail so
    // events produced while this route was inactive are not skipped.
    void controller.reconcile('initial');
    return release;
  }, [controller, networkEnabled, runtimeHealthy, runtimeScope, sessionId]);

  // Mirror the tail back to disk as it changes, so the NEXT open of this session
  // has something to paint. Subscribing to the store (rather than reacting to
  // rendered output) also captures SSE updates that arrive while the transcript
  // is scrolled out of view. The IDB layer batches these on its own timer.
  useEffect(() => {
    if (!canQueryOpenCodeSession(sessionId)) return;
    let lastMessages: unknown;
    let lastParts: unknown;
    const persist = (state: { messages: any; parts: any }) => {
      // The store is shared by every session and also carries status/todos, so
      // most notifications are irrelevant here. Compare the two slices this
      // cache actually mirrors before rebuilding anything.
      if (state.messages[sessionId] === lastMessages && state.parts === lastParts) return;
      lastMessages = state.messages[sessionId];
      lastParts = state.parts;
      void writeCachedTranscript(state, sessionId, kortixSessionScope);
    };
    persist(useSyncStore.getState());
    return useSyncStore.subscribe(persist);
  }, [kortixSessionScope, sessionId]);

  const messages = useSyncStore((state) =>
    state.buildSessionMessages(
      readableSessionId,
      state.messages[readableSessionId],
      state.parts,
    ),
  );

  // The runtime's own status, unmodified.
  //
  // A busy OVERRIDE used to sit here: while a prompt was "observed", an idle
  // runtime status was rewritten to busy. It was a guess with a latch — every
  // signal that could release it can be lost — and it is what left sessions
  // rendering as working until the user reloaded. "Is this session working?"
  // is now answered once, by `useSessionWorking` over the server's turn
  // authority; this hook reports what the stream said and nothing more.
  const status = useSyncStore(
    (state) => state.sessionStatus[readableSessionId] ?? IDLE_STATUS,
  ) as SessionStatus;
  const diffs = useSyncStore((state) => state.diffs[readableSessionId]) as FileDiff[] | undefined;
  const todos = useSyncStore((state) => state.todos[readableSessionId]) as Todo[] | undefined;

  const isBusy = status.type === 'busy' || status.type === 'retry';
  const isLoading = !useSyncStore((state) => readableSessionId in state.messages);

  useEffect(() => {
    controller.setBusy(livenessBusy({ networkEnabled, runtimeHealthy, working, streamBusy: isBusy }));
  }, [controller, isBusy, networkEnabled, runtimeHealthy, working]);

  return {
    messages,
    status,
    freshness: sync.freshness,
    isBusy,
    isLoading,
    hasOlder: sync.hasOlder,
    isLoadingOlder: sync.isLoadingOlder,
    loadOlder: controller.loadOlder,
    diffs: diffs ?? EMPTY_DIFFS,
    todos: todos ?? EMPTY_TODOS,
  };
}
