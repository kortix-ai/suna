'use client';

import { useCallback, useMemo, useState } from 'react';

import type { SessionLogThread } from '../core/session-log/types';
import { useSessionLogOlder, useSessionLogSync, useSessionLogThread } from './use-session-log';

/**
 * What a {@link useSessionView} shows:
 *  - `loading`: the first page is still being read;
 *  - `ready`: the root thread has messages;
 *  - `empty`: the session has no log yet, or its root thread has no message;
 *  - `error`: the read failed (it is retried by itself after 2 s, 10 s and 30 s; `retry` reads now).
 */
export type SessionViewStatus = 'loading' | 'ready' | 'empty' | 'error';

export interface UseSessionViewOptions {
  /** Gate the read and the stream. Default true. */
  enabled?: boolean;
  /** Pace the thread while a turn streams, as `useSessionLogThread`'s `throttleMs`. */
  throttleMs?: number;
}

export interface UseSessionViewResult {
  projectId: string;
  sessionId: string;
  status: SessionViewStatus;
  /** The session's root thread (`kortix.session/2`), live; null until the first page answers. */
  thread: SessionLogThread | null;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => Promise<void>;
  /** Read the log again now (a "Try again" control). */
  retry: () => void;
}

/**
 * A read-only view of one session from the API alone: its session log (`GET …/log`)
 * and the session stream on the v2 schema, live. It never calls `/start`, so it does
 * not wake the session's computer, and it never points the app's one runtime at the
 * session's box, so a host can mount it beside the session page that owns the runtime
 * (a sub-agent's dialog over its lead's chat, a board's preview). Things that need the
 * box (files, previews, a terminal) are not part of a view: open the session for them.
 */
export function useSessionView(projectId: string, sessionId: string, options: UseSessionViewOptions = {}): UseSessionViewResult {
  const enabled = (options.enabled ?? true) && !!projectId && !!sessionId;
  const key = `${projectId}/${sessionId}`;
  const [revision, setRevision] = useState(0);
  // The newest first-page outcome, per session: a new session starts at `loading`.
  const [read, setRead] = useState<{ key: string; outcome: 'page' | 'missing' | 'failed' } | null>(null);
  const onRead = useCallback((outcome: 'page' | 'missing' | 'failed') => setRead({ key, outcome }), [key]);
  useSessionLogSync(projectId, sessionId, { enabled, onRead, revision });
  const source = useMemo(() => ({ projectId, sessionId, runtimeSessionId: null }), [projectId, sessionId]);
  const logThread = useSessionLogThread(source, undefined, options.throttleMs ? { throttleMs: options.throttleMs } : undefined);
  // A view reads only the API's log; the v1 fallback rows of another reader are not this session's view.
  const thread = enabled ? logThread : null;
  const older = useSessionLogOlder(source, undefined, { enabled });
  const outcome = read?.key === key ? read.outcome : null;
  const status: SessionViewStatus =
    thread && thread.messages.length > 0
      ? 'ready'
      : outcome === 'missing' || (outcome === 'page' && thread !== null)
        ? 'empty'
        : outcome === 'failed'
          ? 'error'
          : 'loading';
  const retry = useCallback(() => {
    setRead(null);
    setRevision((value) => value + 1);
  }, []);
  return { projectId, sessionId, status, thread, ...older, retry };
}
