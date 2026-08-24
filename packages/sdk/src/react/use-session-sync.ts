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
import { transcriptIsFragment } from '../core/session-sync/fragment';
import { onTabVisible } from '../browser/session-sync/visibility';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { useCurrentRuntime } from './use-current-runtime';
import { canQueryOpenCodeSession } from './use-opencode-sessions';

export { loadSessionRuntimeStatus, loadSessionTranscriptMessages };

/** The two store slices the fragment check reads. Local so this file does not
 *  depend on the store's full published shape. */
interface SyncStoreShape {
  messages: Record<string, unknown[] | undefined>;
  wasTranscriptEvicted: (sessionID: string) => boolean;
}

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
 * Is this session working, as far as THIS hook can answer?
 *
 * One rule with two readers: the poll's switch below, and the hook's public
 * `isBusy`. They disagreed — `isBusy` derived from the raw stream slot while
 * `livenessBusy` already preferred the caller's projection — so the hook handed
 * out the weaker of two answers it computed side by side.
 */
export function sessionSyncBusy(input: {
  working: boolean | undefined;
  streamBusy: boolean;
}): boolean {
  return input.working ?? input.streamBusy;
}

/**
 * Whether the transcript liveness poll should be running. Pure, so "the
 * projection outranks the stream slot" is a test rather than a convention.
 */
export function livenessBusy(input: {
  networkEnabled: boolean;
  /**
   * Read, and deliberately IGNORED. Retained because this object is a
   * published parameter shape.
   *
   * It used to gate the poll, which inverted the whole point of having one:
   * the repair for a broken stream was switched off by the health probe, and
   * the health probe is the signal that flaps. A loaded box that misses its
   * probe deadline mid-turn lost its transcript repair at the exact moment it
   * needed it, for as long as the probe kept missing. If the box truly is
   * unreachable the tail read fails on its own — bounded by the controller's
   * deadline — at a cost of one request per interval.
   */
  runtimeHealthy?: boolean;
  working: boolean | undefined;
  streamBusy: boolean;
}): boolean {
  if (!input.networkEnabled) return false;
  return sessionSyncBusy(input);
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

  // NO DISK PAINT. The transcript renders from the runtime and from this tab's
  // own optimistic writes — nothing else.
  //
  // There used to be an IndexedDB mirror here, hydrated before `runtimeHealthy`
  // so a hibernated session showed its history instead of a blank screen for
  // the length of a VM boot. It was removed because it could not tell a
  // FINISHED turn from a running one. Its write gate was structural (message
  // count, total part count, tail id), and the two changes that end a turn move
  // none of those: `time.completed` stamped on the tail message, and the `error`
  // an abort stamps. A normal turn escaped by accident, because OpenCode
  // appends a `step-finish` part and that moves the part count — but a STOP
  // appends no part at all. So the disk copy of a stopped thread held an
  // assistant message with neither `time.completed` nor `error`, which
  // `open-turn.ts` reads as STILL RUNNING: on the next cold paint the stopped
  // turn shimmered and every message the user sent after it dimmed to "Queued".
  //
  // The cold-open cost is real and known — see `session-sync-registry`'s
  // `reconcile('initial')` below, which is now the only thing that fills the
  // transcript. If the blank wake is worth solving again, it needs a mirror
  // whose freshness test reads the MESSAGE, not its shape.
  // ASK AS SOON AS WE KNOW WHICH SANDBOX — not when a probe agrees.
  //
  // This read used to wait for `runtimeHealthy === true`, and that one
  // condition is what hung the session page. `resolveSessionContentState` keeps
  // the web app on its "Waking the agent" loader while there are no messages,
  // and this read is the only thing that produces messages. So the page's ONLY
  // exit was a health probe — the least reliable signal in the system — and a
  // box that was up while failing its probe showed a spinner over a session
  // that could have been read the whole time. The sidebar, reading the session
  // list instead, showed the same session as live: one page, two answers.
  //
  // The read IS the liveness check. If the runtime is not up the request fails
  // and the controller retries with backoff until it lands, so readiness
  // becomes a byproduct of asking for what we wanted anyway.
  useEffect(() => {
    if (!networkEnabled || !canQueryOpenCodeSession(sessionId) || runtimeScope === 'none') return;
    resetSessionSyncControllersForSession(sessionId, runtimeScope);
    const release = retainSessionSyncController(sessionId, runtimeScope);
    // The ONLY thing that fills the transcript. One bounded tail, so events
    // produced while this route was inactive are not skipped.
    void controller.reconcile('initial');
    return release;
  }, [controller, networkEnabled, runtimeScope, sessionId]);

  // A transcript the live stream rebuilt after an eviction starts
  // mid-conversation, and nothing else will correct it: the mount already ran,
  // so no `initial` read is coming, and the liveness poll only turns on while
  // the session is working. Removing the IndexedDB mirror (5a7a43517f) named
  // this exact hole and left it open — "no reconcile is keyed on eviction …
  // can sit on a partial transcript until a reload".
  //
  // Subscribed rather than checked once, because the refill happens while this
  // component is already mounted. `hydrate` clears the mark, so the successful
  // read is what disarms this.
  useEffect(() => {
    if (!networkEnabled || !canQueryOpenCodeSession(sessionId)) return;
    let repairing = false;
    const check = (state: SyncStoreShape) => {
      if (repairing) return;
      if (
        !transcriptIsFragment({
          hasMessages: (state.messages[sessionId]?.length ?? 0) > 0,
          wasEvicted: state.wasTranscriptEvicted(sessionId),
        })
      ) {
        return;
      }
      repairing = true;
      void controller.reconcile('eviction').finally(() => {
        repairing = false;
      });
    };
    check(useSyncStore.getState() as unknown as SyncStoreShape);
    return useSyncStore.subscribe((state) => check(state as unknown as SyncStoreShape));
  }, [controller, networkEnabled, sessionId]);

  // Coming back to the tab is a moment of MAXIMUM uncertainty, so it is a
  // moment to re-read. A backgrounded tab has its timers clamped (Chrome: about
  // one tick a minute), so the 10s liveness poll effectively stops, and the SSE
  // connection can be dropped with no visible error. Whatever the transcript
  // shows on return was assembled from a stream nobody was watching. One
  // bounded tail read settles it.
  useEffect(() => {
    if (!networkEnabled || !canQueryOpenCodeSession(sessionId)) return;
    return onTabVisible(() => {
      void controller.reconcile('visible');
    });
  }, [controller, networkEnabled, sessionId]);

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
  //
  // The `?? IDLE_STATUS` default is a DISPLAY convenience and deliberately not
  // what the projection reads: `useSessionWorking` reads the raw slot, where
  // absence means "no frame has ever been observed" — silence, not idle —
  // because reading silence as idle is what unmasked live turns. Widening this
  // to `SessionStatus | undefined` would be a breaking change to a published
  // return type and buys nothing now that `isBusy` no longer derives from it.
  const status = useSyncStore(
    (state) => state.sessionStatus[readableSessionId] ?? IDLE_STATUS,
  ) as SessionStatus;
  const diffs = useSyncStore((state) => state.diffs[readableSessionId]) as FileDiff[] | undefined;
  const todos = useSyncStore((state) => state.todos[readableSessionId]) as Todo[] | undefined;

  const streamBusy = status.type === 'busy' || status.type === 'retry';
  // Published, so it cannot be removed — but it is now an ALIAS of the
  // projection when the caller passed one, so the hook's public answer and the
  // poll's switch are the same rule instead of two.
  const isBusy = sessionSyncBusy({ working, streamBusy });
  const isLoading = !useSyncStore((state) => readableSessionId in state.messages);

  useEffect(() => {
    controller.setBusy(livenessBusy({ networkEnabled, runtimeHealthy, working, streamBusy }));
  }, [controller, streamBusy, networkEnabled, runtimeHealthy, working]);

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
