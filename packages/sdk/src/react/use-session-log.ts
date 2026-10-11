'use client';

import { useEffect, useRef } from 'react';

import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../browser/stores/sync-store';
import {
  fetchFirstSessionLogPage,
  loadSessionLogPage,
  negotiateSessionLog,
  type LoadSessionLogPage,
  type SessionLogDialect,
} from '../core/session-log/source';
import { selectSessionLog, selectSessionLogThread } from '../core/session-log/store';
import type { SessionLog, SessionLogThread } from '../core/session-log/types';
import { useFeatureFlag } from './use-feature-flag';

/**
 * The session log (`kortix.session/2`) of a session a `useSession` hook owns:
 * every thread, its messages by `seq`, and their blocks. `null` while the
 * session reads v1, which is every session until the runtime lists
 * `session.log.v2`, the project flag `session_log` is on, and the API serves
 * the log. The v1 hooks (`useSessionMessages`, `useSession().messages`) read
 * the same records through `toV1`, so a host renders either.
 *
 * Read-only: it starts no request. The record keeps its identity until the
 * session log changes.
 */
export function useSessionLog(session: { projectId: string; sessionId: string }): SessionLog | null {
  return useSyncStore((state) => {
    const log = state.sessionLogs[session.sessionId];
    return log ? selectSessionLog(log) : null;
  });
}

/**
 * One thread of {@link useSessionLog}, with its messages: the root thread when
 * `threadId` is omitted, a sub-agent's thread by its id. `null` while the
 * session reads v1 or the thread is unknown.
 */
export function useSessionLogThread(
  session: { projectId: string; sessionId: string },
  threadId?: string | null,
): SessionLogThread | null {
  return useSyncStore((state) => {
    const log = state.sessionLogs[session.sessionId];
    return log ? selectSessionLogThread(log, threadId) : null;
  });
}

/**
 * Internal (`useSession` mounts it). Negotiates the session's dialect
 * (`negotiateSessionLog`) and, on v2, puts the newest page of the root thread
 * in the store; leaving v2 (or unmounting) drops it, so the v1 hooks read the
 * v1 store again. The flag is read only when this SDK has a page loader, so a
 * build without one sends no extra request.
 */
export function useSessionLogSync(
  projectId: string,
  sessionId: string,
  options: { enabled: boolean; loader?: LoadSessionLogPage | null },
): SessionLogDialect {
  const loader = options.loader === undefined ? loadSessionLogPage : options.loader;
  const active = options.enabled && !!loader && !!projectId && !!sessionId;
  const live = useSandboxConnectionStore((state) => state.runtimeCapabilities);
  // The runtime's answer is latched for the mounted session: a reconnect clears the list
  // (`use-runtime-reconnect.ts`), and re-negotiating v1 there would drop the log, flip the
  // rows to v1 and refetch the page. The flag is not latched: turning it off returns to v1.
  // ponytail: the list is host-global (the last health any session answered), as in
  // `useRuntimeSupports`; key it per session when two sessions with different runtimes mount.
  const served = useRef<string | null>(null);
  const key = `${projectId}/${sessionId}`;
  if (live?.includes('session.log.v2')) served.current = key;
  const capabilities = served.current === key ? ['session.log.v2'] : live;
  const flag = useFeatureFlag(active ? projectId : null, 'session_log').enabled;
  const dialect = active ? negotiateSessionLog({ capabilities, flag, loader }) : 'v1';

  useEffect(() => {
    if (dialect !== 'v2' || !loader) return;
    const controller = new AbortController();
    void fetchFirstSessionLogPage(loader, projectId, sessionId, controller.signal).then((page) => {
      if (page && !controller.signal.aborted) useSyncStore.getState().applySessionLogPage(sessionId, page);
    });
    return () => {
      controller.abort();
      useSyncStore.getState().dropSessionLog(sessionId);
    };
  }, [dialect, loader, projectId, sessionId]);

  return dialect;
}
