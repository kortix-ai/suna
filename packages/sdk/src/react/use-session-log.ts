'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { openSessionStream, type SessionControlStreamOptions } from '../core/session/control-stream';
import { savedSessionLogCopies } from '../core/session-log/saved-log';
import { sessionLogOfV1Rows, sessionLogThreadWithV1Rows } from '../core/session-log/v1-view';
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
import { selectSessionRows } from './session-transcript-subscription';
import { usePacedStoreValue, useSessionMessages, type SessionMessagesOptions, type SessionMessagesSource } from './use-session-messages';

/** The unpaced selector's answer while `throttleMs` paces the thread. */
const PACED = Symbol('paced');

const sourced = new WeakMap<SessionLog, SessionLog & { source: 'v1' | 'v2' }>();
const withSource = (log: SessionLog, source: 'v1' | 'v2') => {
  let out = sourced.get(log);
  if (!out) sourced.set(log, (out = { ...log, source }));
  return out;
};

/**
 * The session log of runtime session `threadId ?? root` while the session reads v1: the
 * `fromV1` view (`sessionLogOfV1Rows`) of the rows `useSessionMessages` renders. Null
 * without a runtime session id, and while the store holds no row for it. `enabled: false`
 * (a v2 log exists) reads no rows, so a v1 row change does not re-render the caller.
 */
function useV1SessionLog(session: SessionMessagesSource, threadId: string | null | undefined, enabled: boolean, options?: SessionMessagesOptions): SessionLog | null {
  const native = enabled ? threadId || session.runtimeSessionId || session.opencodeSessionId || null : null;
  const rows = useSessionMessages({ ...session, runtimeSessionId: native, opencodeSessionId: null }, options);
  return useMemo(() => (native && rows.length ? sessionLogOfV1Rows(session.sessionId, native, rows) : null), [session.sessionId, native, rows]);
}

/**
 * The session log (`kortix.session/2`) of a session a `useSession` hook owns: every thread,
 * its messages by `seq`, and their blocks. `source` names where it came from:
 *  - `'v2'`: the API's session log, once the runtime lists `session.log.v2`, the project flag
 *    `session_log` is on, and the API serves the log. The v1 hooks (`useSessionMessages`,
 *    `useSession().messages`) read the same records through `toV1`.
 *  - `'v1'`: before that, the `fromV1` conversion of the v1 rows `useSessionMessages` renders
 *    for `runtimeSessionId`: one root thread whose id is the runtime session id. The turn that
 *    runs stays open (`fromV1` with `live: true`). Null without a `runtimeSessionId`, and
 *    while the store holds no row for it.
 *
 * Read-only: it starts no request. The record keeps its identity until the session log (v2)
 * or the rows (v1) change, and a v1 message keeps its identity while its row is unchanged.
 */
export function useSessionLog(session: SessionMessagesSource): (SessionLog & { source: 'v1' | 'v2' }) | null {
  const v2 = useSyncStore((state) => {
    const log = state.sessionLogs[session.sessionId];
    return log ? selectSessionLog(log) : null;
  });
  const v1 = useV1SessionLog(session, undefined, !v2);
  return v2 ? withSource(v2, 'v2') : v1 ? withSource(v1, 'v1') : null;
}

/**
 * The session record of a session's v2 log, without its threads: `restore_grade`,
 * `grade_counts`, `harness`, `ext` and the other session fields, as the API's page and the
 * stream's `log.state` frames built them (a field not sent yet is absent). Null while the session
 * reads v1. The record keeps its identity through message puts and block deltas, so a consumer
 * re-renders only when a page or a session patch changes it: read session fields here, not
 * through {@link useSessionLog}, which changes with every message.
 */
export function useSessionLogRecord(session: Pick<SessionMessagesSource, 'sessionId'>): Partial<Omit<SessionLog, 'threads'>> | null {
  return useSyncStore((state) => state.sessionLogs[session.sessionId]?.session ?? null);
}

/**
 * One thread of {@link useSessionLog}, with its messages: the root thread when `threadId` is
 * omitted, a sub-agent's thread by its id. On v1 a thread id is a runtime session id, and the
 * thread is the `fromV1` view of that runtime session's rows. On v2 the v1 store rows the log
 * does not hold yet (an optimistic send) follow the thread's messages as `fromV1` messages,
 * until the log's put of the same id replaces them. `null` when the thread is unknown (v2), or
 * the store holds no row of that runtime session (v1). `options.throttleMs` paces the thread on
 * both paths as {@link useSessionMessages} paces the v1 rows: a transcript reads a streaming turn
 * at most once per window (leading and trailing edge; the last change always lands).
 */
export function useSessionLogThread(
  session: SessionMessagesSource,
  threadId?: string | null,
  options?: SessionMessagesOptions,
): SessionLogThread | null {
  const throttleMs = options?.throttleMs && options.throttleMs > 0 ? options.throttleMs : 0;
  const select = (state: ReturnType<typeof useSyncStore.getState>) => {
    const log = state.sessionLogs[session.sessionId];
    if (!log) return undefined;
    const thread = selectSessionLogThread(log, threadId);
    // The v1 rows the log lacks (an optimistic send) show until the log's put replaces them.
    return thread && sessionLogThreadWithV1Rows(log, thread, selectSessionRows(state, thread.thread_id), (id) => state.optimisticEchoOf(thread.thread_id, id));
  };
  // Unpaced: a plain store subscription. Paced: the selector is constant, and the paced
  // value delivers the thread on its own schedule, as `useSessionMessages` paces the v1 rows.
  const live = useSyncStore((state) => (throttleMs ? PACED : select(state)));
  const paced = usePacedStoreValue(select, `${session.sessionId}/${threadId ?? ''}`, throttleMs);
  const v2 = live === PACED ? paced : live;
  const v1 = useV1SessionLog(session, threadId, v2 === undefined, options);
  return v2 !== undefined ? v2 : (v1?.threads[0] ?? null);
}

/**
 * Internal (`useSession` mounts it). Negotiates the session's dialect
 * (`negotiateSessionLog`). On v2:
 *  1. the device's saved v2 copy paints first;
 *  2. the newest page of the root thread replaces it and is saved (the v1 copy goes);
 *  3. the session stream switches to `schema=v2` (`log.*` frames in place of the `message.*`
 *     ones) at the same runtime cursor; the page is read again after each reconnect and on a
 *     `kortix.resync` (a v2 log on another epoch replays nothing for the old cursor).
 * Both kinds of thread read v2: a `fromV1` one (OpenCode) and a native one (pi). Hosts render
 * the blocks (`sessionLogTurns`); the v1 hooks read a native thread through `toV1`.
 * A 404 (a new session whose journal has not posted yet) or an invalid page leaves the session
 * on v1: no session log, no `schema=v2`. It is retried at the next turn end and after a stream
 * reconnect, one request at a time.
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
  // The page answered that this session cannot read v2 yet (404, invalid).
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
      if (page) {
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
      if (page) {
        setRefusedKey(null);
        // A v2 connection resumes at the v1 cursor; a server on another epoch answers
        // `kortix.resync` and replays nothing, so the page is read again then, as after a reconnect.
        join({ schema: 'v2', onConnectionChange: onReconnect(() => void load()), onRuntimeResync: () => void load() });
        return;
      }
      store().dropSessionLog(sessionId);
      setRefusedKey(`${projectId}/${sessionId}`);
      // A missing log (a new session whose journal has not posted yet) or an invalid page is
      // retried at the next turn end and after a stream reconnect, on the session stream
      // without `schema=v2`.
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
      if (saved && !store().sessionLogs[sessionId]) store().applySessionLogPage(sessionId, saved);
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
