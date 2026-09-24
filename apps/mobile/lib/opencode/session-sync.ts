/** Session synchronization through the framework-free @kortix/sdk controller. */

import { getAuthToken } from '@/api/config';
import { createHttpSessionSyncController, type SessionSyncMessage } from '@kortix/sdk';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { selectSessionsToEvict, useSyncStore } from './sync-store';
import type { MessageWithParts } from './types';

type SessionSyncController = ReturnType<typeof createHttpSessionSyncController>;
type SessionSyncSnapshot = ReturnType<SessionSyncController['getSnapshot']>;
export type SessionSyncReason = NonNullable<Parameters<SessionSyncController['reconcile']>[0]>;

// Module-scope so `useSyncExternalStore` sees the same snapshot and subscribe
// function on every render while there is no controller. A new object per
// `getSnapshot` call makes React re-render until "Maximum update depth exceeded".
export const EMPTY_SNAPSHOT: SessionSyncSnapshot = {
  freshness: 'idle',
  hasOlder: false,
  isLoadingOlder: false,
};
export const getEmptySnapshot = (): SessionSyncSnapshot => EMPTY_SNAPSHOT;
export const noopSubscribe = (_listener: () => void): (() => void) => noopUnsubscribe;
const noopUnsubscribe = () => {};

// ---------------------------------------------------------------------------
// Live session registry
// ---------------------------------------------------------------------------

/**
 * Transcripts of detached sessions kept in the store for an instant reopen.
 * Older detached sessions are evicted. Same limit as the SDK browser store.
 */
export const DETACHED_SESSION_LIMIT = 3;

interface LiveSession {
  sessionId: string;
  sandboxUrl: string;
  controller: Pick<SessionSyncController, 'reconcile'>;
}

const liveSessions = new Set<LiveSession>();
/** Detached session ids, most recently detached first. */
let detachedSessionIds: string[] = [];
interface InFlightReconcile {
  reason: SessionSyncReason;
  promise: Promise<void>;
  /** One queued read for a different reason, started after this one settles. */
  followUp?: Promise<void>;
}

/** Controllers with a reconcile in flight, so overlapping gaps do not stack. */
const reconcilesInFlight = new Map<LiveSession['controller'], InFlightReconcile>();

function reconcileOne(entry: LiveSession, reason: SessionSyncReason): Promise<void> {
  const running = reconcilesInFlight.get(entry.controller);
  if (running) {
    if (running.reason === reason) return running.promise;
    // A read for another reason (e.g. compaction during a gap read) may need
    // data the running read started too early to see: queue one more read.
    running.followUp ??= running.promise.then(() =>
      liveSessions.has(entry) ? reconcileOne(entry, reason) : undefined,
    );
    return running.followUp;
  }
  const record: InFlightReconcile = {
    reason,
    promise: entry.controller
      .reconcile(reason)
      .catch(() => {
        // The controller records its own failure state and retries.
      })
      .finally(() => {
        if (reconcilesInFlight.get(entry.controller) === record) {
          reconcilesInFlight.delete(entry.controller);
        }
      }),
  };
  reconcilesInFlight.set(entry.controller, record);
  return record.promise;
}

/**
 * Track a mounted session controller. Returns the unregister function. When
 * the last controller of a session unregisters, the session becomes the most
 * recently detached one, and sessions beyond `DETACHED_SESSION_LIMIT` that are
 * neither live nor working are evicted from the sync store.
 */
export function registerLiveSession(entry: LiveSession): () => void {
  liveSessions.add(entry);
  detachedSessionIds = detachedSessionIds.filter((id) => id !== entry.sessionId);
  return () => {
    if (!liveSessions.delete(entry)) return;
    reconcilesInFlight.delete(entry.controller);
    const liveIds = new Set([...liveSessions].map((live) => live.sessionId));
    if (liveIds.has(entry.sessionId)) return;
    detachedSessionIds = [
      entry.sessionId,
      ...detachedSessionIds.filter((id) => id !== entry.sessionId),
    ].slice(0, DETACHED_SESSION_LIMIT);
    const keep = new Set([...liveIds, ...detachedSessionIds]);
    const store = useSyncStore.getState();
    const evict = selectSessionsToEvict(store, keep);
    if (evict.length > 0) store.evictSessions(evict);
  };
}

/**
 * Re-read the tail page of every live session, optionally only those on
 * `sandboxUrl`. Used after an SSE gap: bounded to mounted sessions and one
 * page each, never the full history of every session ever loaded.
 */
export function reconcileLiveSessions(
  reason: SessionSyncReason,
  sandboxUrl?: string,
): Promise<void> {
  const requests: Promise<void>[] = [];
  for (const entry of liveSessions) {
    if (sandboxUrl !== undefined && entry.sandboxUrl !== sandboxUrl) continue;
    requests.push(reconcileOne(entry, reason));
  }
  return Promise.all(requests).then(() => undefined);
}

/** Re-read the tail page of one live session (e.g. after compaction). */
export function reconcileLiveSession(sessionId: string, reason: SessionSyncReason): Promise<void> {
  const requests: Promise<void>[] = [];
  for (const entry of liveSessions) {
    if (entry.sessionId === sessionId) requests.push(reconcileOne(entry, reason));
  }
  return Promise.all(requests).then(() => undefined);
}

/** True while at least one mounted session page holds this session. */
export function isLiveSession(sessionId: string): boolean {
  for (const entry of liveSessions) {
    if (entry.sessionId === sessionId) return true;
  }
  return false;
}

/** Test-only: forget every registration. */
export function resetLiveSessionsForTest() {
  liveSessions.clear();
  reconcilesInFlight.clear();
  detachedSessionIds = [];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSessionSync(sandboxUrl: string | undefined, sessionId: string | undefined) {
  const controller = useMemo(() => {
    if (!sandboxUrl || !sessionId) return null;
    return createHttpSessionSyncController({
      baseUrl: sandboxUrl,
      sessionId,
      getToken: getAuthToken,
      hydrate: (messages: SessionSyncMessage[]) => {
        // Mobile still carries a legacy local OpenCode type mirror. The wire
        // payload is identical; keep the compatibility assertion at this one
        // adapter boundary until that mirror is retired.
        useSyncStore.getState().hydrate(sessionId, messages as unknown as MessageWithParts[]);
      },
      markLoaded: () => {
        const store = useSyncStore.getState();
        if (!(sessionId in store.messages)) store.hydrate(sessionId, []);
      },
      setStatus: (status) => {
        useSyncStore.getState().setStatus(sessionId, status);
      },
    });
  }, [sandboxUrl, sessionId]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? getEmptySnapshot,
    controller?.getSnapshot ?? getEmptySnapshot,
  );
  const status = useSyncStore((state) => (sessionId ? state.sessionStatus[sessionId] : undefined));
  const messages = useSyncStore((state) => (sessionId ? state.messages[sessionId] : undefined));

  useEffect(() => {
    if (!controller || !sandboxUrl || !sessionId) return;
    const unregister = registerLiveSession({ sessionId, sandboxUrl, controller });
    void controller.start();
    return () => {
      controller.destroy();
      unregister();
    };
  }, [controller, sandboxUrl, sessionId]);

  useEffect(() => {
    if (messages) controller?.noteActivity();
  }, [controller, messages]);

  useEffect(() => {
    controller?.setBusy(status?.type === 'busy' || status?.type === 'retry');
  }, [controller, status?.type]);

  return {
    ...snapshot,
    loadOlder: () => controller?.loadOlder() ?? Promise.resolve(),
  };
}
