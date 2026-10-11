'use client';

import { useEffect, useRef, useState } from 'react';

import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { openSessionStream, type SessionControlStreamOptions } from '../core/session/control-stream';
import { savedSessionLogCopies } from '../core/session-log/saved-log';
import { isV1Thread } from '../core/session-log/v1-view';
import {
  fetchFirstSessionLogPage,
  loadSessionLogPage,
  negotiateSessionLog,
  type LoadSessionLogPage,
  type SessionLogDialect,
  type SessionLogPage,
} from '../core/session-log/source';
import { currentSavedCopyStore } from '../core/session-sync/saved-copy-store';
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

/** Only a page of a `fromV1` thread is read as v2 (`isV1Thread`). */
const pageThreadIsV1 = (page: SessionLogPage) => isV1Thread(page.threads.find((t) => t.thread_id === page.thread_id));

/**
 * Internal (`useSession` mounts it). Negotiates the session's dialect
 * (`negotiateSessionLog`). On v2:
 *  1. the device's saved v2 copy paints first;
 *  2. the newest page of the root thread replaces it and is saved (the v1 copy goes);
 *  3. when that thread is a `fromV1` thread, the session stream switches to `schema=v2`
 *     (`log.*` frames in place of the `message.*` ones) at the same runtime cursor; the page is
 *     read again after each reconnect and on a `kortix.resync` (a v2 log on another epoch
 *     replays nothing for the old cursor).
 * A thread `fromV1` did not build (pi writes native records, which render lossy through
 * `toV1`) leaves the session on v1: no session log, no `schema=v2`. A 404 (a new session whose
 * journal has not posted yet) or an invalid page leaves it on v1 too, and is retried at the next
 * turn end and after a stream reconnect, one request at a time.
 * Leaving v2 (or unmounting) drops the log, so the v1 hooks read the v1 store again. The flag
 * is read only when this SDK has a page loader.
 */
export function useSessionLogSync(
  projectId: string,
  sessionId: string,
  options: {
    enabled: boolean;
    loader?: LoadSessionLogPage | null;
    /** Test seam: joins the session stream. */
    joinStream?: (options: SessionControlStreamOptions) => { close: () => void };
  },
): SessionLogDialect {
  const loader = options.loader === undefined ? loadSessionLogPage : options.loader;
  const joinStream = options.joinStream ?? openSessionStream;
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
  const negotiated = active ? negotiateSessionLog({ capabilities, flag, loader }) : 'v1';
  // The page answered that this session cannot read v2 (404, invalid, not a `fromV1` thread).
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const dialect: SessionLogDialect = negotiated === 'v2' && refusedKey !== key ? 'v2' : 'v1';

  useEffect(() => {
    if (negotiated !== 'v2' || !loader) return;
    const controller = new AbortController();
    const store = useSyncStore.getState;
    const copies = savedSessionLogCopies(currentSavedCopyStore());
    let stream: { close: () => void } | null = null;
    let stopped = false;
    let busy = false;
    // The last turn end the session stream reported, kept across re-joins: a different one is a turn end.
    let lastEnded: string | null | undefined;
    const join = (options: Omit<SessionControlStreamOptions, 'projectId' | 'sessionId'>) => {
      stream?.close();
      stream = joinStream({ projectId, sessionId, ...options });
    };
    const load = async (): Promise<SessionLogPage | null> => {
      const page = await fetchFirstSessionLogPage(loader, projectId, sessionId, controller.signal);
      if (stopped) return null;
      // Only a page this session reads (a `fromV1` thread) goes in the store and the device copy:
      // a pi page would replace the v1 copy with one nothing paints.
      if (page && pageThreadIsV1(page)) {
        store().applySessionLogPage(sessionId, page);
        void copies?.write(projectId, sessionId, page);
      }
      return page;
    };
    // Re-read after a reconnect (`up` after a drop); the first report is the connection already up.
    const onReconnect = (run: () => void) => {
      let connected = true;
      return (up: boolean) => {
        if (up && !connected) run();
        connected = up;
      };
    };
    const attempt = async (): Promise<void> => {
      if (busy || stopped) return;
      busy = true;
      const page = await load();
      busy = false;
      if (stopped) return;
      if (page && pageThreadIsV1(page)) {
        setRefusedKey(null);
        // A v2 connection resumes at the v1 cursor; a server on another epoch answers
        // `kortix.resync` and replays nothing, so the page is read again then, as after a reconnect.
        join({ schema: 'v2', onConnectionChange: onReconnect(() => void load()), onRuntimeResync: () => void load() });
        return;
      }
      store().dropSessionLog(sessionId);
      setRefusedKey(`${projectId}/${sessionId}`);
      // A native thread (pi) never becomes a `fromV1` one: stay on v1. A missing log (a new
      // session whose journal has not posted yet) or an invalid page is retried at the next
      // turn end and after a stream reconnect, on the session stream without `schema=v2`.
      if (page) return;
      join({
        onControl: (frame) => {
          if (frame.type !== 'kortix.control.turn') return;
          const ended = (frame.payload as { last_ended?: { turn_token?: string } | null })?.last_ended?.turn_token ?? null;
          const seen = lastEnded;
          lastEnded = ended;
          if (seen !== undefined && ended !== seen) void attempt();
        },
        onConnectionChange: onReconnect(() => void attempt()),
      });
    };
    void (async () => {
      const saved = await Promise.resolve(copies?.read(projectId, sessionId) ?? null).catch(() => null);
      if (stopped) return;
      if (saved && pageThreadIsV1(saved) && !store().sessionLogs[sessionId]) store().applySessionLogPage(sessionId, saved);
      await attempt();
    })();
    return () => {
      stopped = true;
      controller.abort();
      stream?.close();
      store().dropSessionLog(sessionId);
    };
  }, [negotiated, loader, joinStream, projectId, sessionId]);

  return dialect;
}
