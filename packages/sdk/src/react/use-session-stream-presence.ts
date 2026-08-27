'use client';

import { useSyncExternalStore } from 'react';
import {
  isSessionStreamConnected,
  subscribeSessionStreamPresence,
} from '../core/stream/session-stream-presence';

/**
 * Is the session stream delivering for `(projectId, sessionId)` right now?
 *
 * The control channel of that stream carries the SAME projections the `/turn`
 * and `/prompts` polls fetch, from the same server functions — so while it is
 * connected, those polls hand their cadence over (`refetchInterval: false`)
 * and this hook is the switch. A surface mounted with no stream on the page,
 * or a client that cannot reach the stream, keeps its poll.
 */
export function useSessionStreamPresence(scope: string): boolean {
  return useSyncExternalStore(
    (onChange) => (scope ? subscribeSessionStreamPresence(scope, onChange) : () => {}),
    () => !!scope && isSessionStreamConnected(scope),
    // On the server no stream exists to be connected.
    () => false,
  );
}

/** The scope key both the stream hook and the poll owners agree on. */
export function sessionStreamScope(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}
