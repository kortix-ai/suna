'use client';

import { useSyncExternalStore } from 'react';
import {
  getSessionAuditTick,
  isSessionStreamConnected,
  isSessionTurnCorroborated,
  subscribeSessionAudit,
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

/**
 * Has the control channel actually answered about turns since this stream
 * attached?
 *
 * `useSessionStreamPresence` says a stream is CONNECTED. That is a promise the
 * control channel will carry turn state; it is not the state having arrived.
 * The reconciler pushes `kortix.control.turn` on CHANGE, so a session resumed
 * with a row already open produces no change and no frame — and the poll that
 * would have converged it has already stood down on presence alone. Poll
 * owners pair the two so they only hand their cadence over once someone has
 * actually answered.
 */
export function useSessionTurnCorroborated(scope: string): boolean {
  return useSyncExternalStore(
    (onChange) => (scope ? subscribeSessionStreamPresence(scope, onChange) : () => {}),
    () => !!scope && isSessionTurnCorroborated(scope),
    () => false,
  );
}

/** The scope key both the stream hook and the poll owners agree on. */
export function sessionStreamScope(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

/**
 * The per-session audit watermark tick for `(projectId, sessionId)`.
 *
 * It changes when a `kortix.control.audit` frame reports a real change — a
 * connector-gated approval appeared or was resolved. The audit surface reads it
 * to invalidate its query on that push instead of polling, and pairs it with
 * `useSessionStreamPresence(scope)` to stand its poll down while the stream is
 * connected. Returns `0` until the first change (and on the server).
 */
export function useSessionAuditSignal(projectId: string, sessionId: string): number {
  const scope = projectId && sessionId ? sessionStreamScope(projectId, sessionId) : '';
  return useSyncExternalStore(
    (onChange) => (scope ? subscribeSessionAudit(scope, onChange) : () => {}),
    () => (scope ? getSessionAuditTick(scope) : 0),
    () => 0,
  );
}
