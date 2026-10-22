'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { onTabVisible } from '../browser/session-sync/visibility';
import { useSyncStore } from '../browser/stores/sync-store';
import { openSessionStream, type SessionControlStreamOptions } from '../core/session/control-stream';
import { savedSessionLogCopies } from '../core/session-log/saved-log';
import { sessionLogOfV1Rows, sessionLogThreadWithV1Rows } from '../core/session-log/v1-view';
import {
  fetchSessionLogPage,
  readFirstSessionLogAnswer,
  takeHeldFirstSessionLogPage,
  loadSessionLogPage,
  SESSION_LOG_FIRST_PAGE_LIMIT,
  SESSION_LOG_OLDER_PAGE_LIMIT,
  type LoadSessionLogPage,
  type SessionLogDialect,
  type SessionLogSyncState,
  type SessionLogPage,
} from '../core/session-log/source';
import { currentSavedCopyStore } from '../core/session-sync/saved-copy-store';
import { selectSessionLog, selectSessionLogThread } from '../core/session-log/store';
import type { SessionLog, SessionLogThread } from '../core/session-log/types';
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
 *  - `'v2'`: the API's session log, once the API serves the session's log. The v1 hooks (`useSessionMessages`,
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

/** The thread pages in flight, one per session and thread, however many rows show the thread. */
const threadReads = new Set<string>();
/** When a thread's read last failed (the journal had not posted it yet): it is retried after {@link THREAD_RETRY_MS}. */
const threadFailedAt = new Map<string, number>();
const THREAD_RETRY_MS = 5_000;

/** Reads a sub-agent thread's first page. Internal; tests replace it (`undefined` restores the default) and start clean. */
let threadLoader: LoadSessionLogPage | null = loadSessionLogPage;
export function setSessionLogThreadLoader(loader: LoadSessionLogPage | null | undefined): void {
  threadLoader = loader === undefined ? loadSessionLogPage : loader;
  threadFailedAt.clear();
}

function readThread(projectId: string, sessionId: string, threadId: string): void {
  const key = `${sessionId}\u0000${threadId}`;
  if (!threadLoader || threadReads.has(key) || Date.now() - (threadFailedAt.get(key) ?? -Infinity) < THREAD_RETRY_MS) return;
  threadReads.add(key);
  void fetchSessionLogPage(threadLoader, projectId, sessionId, { thread: threadId, limit: SESSION_LOG_FIRST_PAGE_LIMIT })
    .then((page) => {
      if (page?.thread_id !== threadId) return void threadFailedAt.set(key, Date.now());
      threadFailedAt.delete(key);
      // The log may have gone (the session left v2) while the page was read.
      if (useSyncStore.getState().sessionLogs[sessionId]) useSyncStore.getState().applySessionLogPage(sessionId, page);
    })
    .finally(() => threadReads.delete(key));
}

/**
 * One thread of {@link useSessionLog}, with its messages: the root thread when `threadId` is
 * omitted, a sub-agent's thread by its id. On v1 a thread id is a runtime session id, and the
 * thread is the `fromV1` view of that runtime session's rows. On v2 the v1 store rows the log
 * does not hold yet join the thread's messages as `fromV1` messages, placed by time (an older
 * page before them, an optimistic send after them), until the log's put of the same id replaces them. `null` when the thread is unknown (v2), or
 * the store holds no row of that runtime session (v1). `options.throttleMs` paces the thread on
 * both paths as {@link useSessionMessages} paces the v1 rows: a transcript reads a streaming turn
 * at most once per window (leading and trailing edge; the last change always lands).
 * On v2 a sub-agent thread the log names but has not read yet loads its newest page
 * (`GET …/log?thread=`), once per session and thread; the root thread is `useSession`'s. A
 * failed read (the journal has not posted the thread yet) retries when the thread's next
 * message arrives, at most every 5 s.
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
  // -1: nothing to read. Else the thread's message count: a failed read retries when it grows.
  const unread = useSyncStore((state) => {
    const log = threadId ? state.sessionLogs[session.sessionId] : undefined;
    const head = threadId ? log?.threads[threadId] : undefined;
    return head && head.parent_thread_id !== null && log!.older[threadId!] === undefined ? (log!.messages[threadId!]?.length ?? 0) : -1;
  });
  const { projectId, sessionId } = session;
  useEffect(() => {
    if (unread >= 0 && projectId && threadId) readThread(projectId, sessionId, threadId);
  }, [unread, projectId, sessionId, threadId]);
  return v2 !== undefined ? v2 : (v1?.threads[0] ?? null);
}

/**
 * Older messages of one thread of a v2 session, from `GET …/log?thread=&before_seq=`: the
 * root thread when `threadId` is omitted. `hasOlder` is the oldest page's `has_more`;
 * `loadOlder` reads the page before the thread's first `seq` (one request at a time, the
 * same promise to every caller). A failed read stops offering older messages, so a loop
 * that drains the history (print) ends. Nothing on v1: the session has no log.
 */
export function useSessionLogOlder(
  session: Pick<SessionMessagesSource, 'projectId' | 'sessionId'>,
  threadId?: string | null,
  options: { enabled?: boolean; loader?: LoadSessionLogPage | null } = {},
): { hasOlder: boolean; isLoadingOlder: boolean; loadOlder: () => Promise<void> } {
  const loader = options.loader === undefined ? loadSessionLogPage : options.loader;
  const enabled = (options.enabled ?? true) && !!loader;
  const { projectId, sessionId } = session;
  const thread = useSyncStore((state) => {
    const log = state.sessionLogs[sessionId];
    if (!log) return null;
    return threadId ?? Object.values(log.threads).find((head) => head.parent_thread_id === null)?.thread_id ?? null;
  });
  const more = useSyncStore((state) => (thread ? state.sessionLogs[sessionId]?.older[thread] === true : false));
  const key = `${projectId}/${sessionId}/${thread ?? ''}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const inFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const loadOlder = useCallback((): Promise<void> => {
    if (!enabled || !loader || !thread || !projectId) return Promise.resolve();
    if (inFlight.current?.key === key) return inFlight.current.promise;
    const state = useSyncStore.getState().sessionLogs[sessionId];
    const first = state?.messages[thread]?.[0]?.seq;
    if (state?.older[thread] !== true || first === undefined) return Promise.resolve();
    setLoadingKey(key);
    const promise = fetchSessionLogPage(loader, projectId, sessionId, { thread, before_seq: first, limit: SESSION_LOG_OLDER_PAGE_LIMIT })
      .then((page) => {
        if (page?.thread_id === thread && useSyncStore.getState().sessionLogs[sessionId]) useSyncStore.getState().applySessionLogPage(sessionId, page, first);
        else setFailedKey(key);
      })
      .finally(() => {
        if (inFlight.current?.promise === promise) inFlight.current = null;
        setLoadingKey((current) => (current === key ? null : current));
      });
    inFlight.current = { key, promise };
    return promise;
  }, [enabled, loader, thread, projectId, sessionId, key]);
  return { hasOlder: enabled && more && failedKey !== key, isLoadingOlder: loadingKey === key, loadOlder };
}

/**
 * Internal (`useSession` mounts it). Negotiates the session's dialect from the API's answer
 * alone: no project flag, no runtime. `'v2'` from the first render, while the first page is
 * read; `useSession` reads no v1 saved copy then. On v2:
 *  1. the device's saved v2 copy paints first;
 *  2. the newest page of the root thread replaces it and is saved (the v1 copy goes);
 *  3. the session stream switches to `schema=v2` (`log.*` frames in place of the `message.*`
 *     ones) at the same runtime cursor; the page is read again after each reconnect, on a
 *     `kortix.resync` (a v2 log on another epoch replays nothing for the old cursor), and when
 *     the tab becomes visible again.
 * Both kinds of thread read v2: a `fromV1` one (OpenCode) and a native one (pi). Hosts render
 * the blocks (`sessionLogTurns`); the v1 hooks read a native thread through `toV1`.
 * A 404 coded `session_log_missing` (a new session whose journal has not posted yet) answers
 * `'missing'`: still v2, with no log yet, so `useSession` reads no v1 saved copy and has nothing
 * saved to wait for. A 404 without that code (an API older than the log) or an invalid page
 * leaves the session on v1: no session log, no `schema=v2`. Either is retried at the next turn end
 * and after a stream reconnect (on the session stream without `schema=v2`), one request at a time.
 * Leaving v2 (or unmounting) drops the log, so the v1 hooks read the v1 store again.
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
): SessionLogSyncState {
  const loader = options.loader === undefined ? loadSessionLogPage : options.loader;
  const joinStream = options.joinStream ?? openSessionStream;
  const active = options.enabled && !!loader && !!projectId && !!sessionId;
  const key = `${projectId}/${sessionId}`;
  const negotiated: SessionLogDialect = active ? 'v2' : 'v1';
  // The page answered that this session cannot read v2 (404 without a code, invalid): v1 from then on.
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  // The API serves the log and this session has none yet (404 `session_log_missing`).
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const state: SessionLogSyncState =
    negotiated !== 'v2' || refusedKey === key ? 'v1' : missingKey === key ? 'missing' : 'v2';

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
    // The page answered: the stream is on `schema=v2`.
    let onV2 = false;
    const join = (options: Omit<SessionControlStreamOptions, 'projectId' | 'sessionId'>) => {
      stream?.close();
      stream = joinStream({ projectId, sessionId, ...options });
    };
    // The first read of the bind takes the page a connecting view just read (`readSavedSessionCopy`).
    let held: SessionLogPage | null = takeHeldFirstSessionLogPage(projectId, sessionId);
    const load = async (): Promise<SessionLogPage | 'missing' | null> => {
      const answer = held ?? (await readFirstSessionLogAnswer(loader, projectId, sessionId, controller.signal));
      held = null;
      if (stopped) return null;
      if (answer && answer !== 'missing') {
        store().applySessionLogPage(sessionId, answer);
        void copies?.write(projectId, sessionId, answer);
      }
      return answer;
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
      const answer = await load();
      busy = false;
      if (stopped) return;
      const page = answer === 'missing' ? null : answer;
      onV2 = !!page;
      if (page) {
        setRefusedKey(null);
        setMissingKey(null);
        // A v2 connection resumes at the v1 cursor; a server on another epoch answers
        // `kortix.resync` and replays nothing, so the page is read again then, as after a reconnect.
        join({ schema: 'v2', onConnectionChange: onReconnect(() => void load()), onRuntimeResync: () => void load() });
        return;
      }
      store().dropSessionLog(sessionId);
      if (answer === 'missing') setMissingKey(`${projectId}/${sessionId}`);
      else setRefusedKey(`${projectId}/${sessionId}`);
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
    // A tab that comes back is the least sure it has every frame (a background tab can lose
    // its stream silently): read the newest page again, as the v1 transcript reads its tail.
    // A refused session waits for its next turn end or reconnect instead.
    const stopVisible = onTabVisible(() => {
      if (onV2) void load();
    });
    return () => {
      stopVisible();
      stopped = true;
      controller.abort();
      stream?.close();
      store().dropSessionLog(sessionId);
    };
  }, [negotiated, loader, joinStream, projectId, sessionId]);

  return state;
}
