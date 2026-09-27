'use client';

import { useEffect, useMemo, useState } from 'react';

import { useSyncStore, type MessageWithParts } from '../browser/stores/sync-store';
import { messagesBeforeRewind } from '../core/session/rewind';
import { selectSessionRows, useReadableSessionId } from './session-transcript-subscription';

/** The identity `useSessionMessages` needs from a `useSession` result. */
export interface SessionMessagesSource {
  projectId: string;
  sessionId: string;
  /** Canonical OpenCode root id, or null while resolving. */
  opencodeSessionId: string | null;
}

/** Options for {@link useSessionMessages}. */
export interface SessionMessagesOptions {
  /**
   * Deliver transcript changes at most once per `throttleMs` (leading and
   * trailing edge). Omit, or pass 0, to re-render on every store change.
   *
   * A streaming turn changes the rows once per ~16 ms event batch. A component
   * that derives a lot from the transcript (grouping, per-turn props) can pace
   * that: the first change after a quiet interval shows at once, changes
   * inside the interval collapse into one render of the latest rows at its
   * edge, and the latest rows always land.
   */
  throttleMs?: number;
}

const EMPTY_ROWS: MessageWithParts[] = [];

/**
 * The live transcript of a session a `useSession` hook owns — the same rows,
 * with the same staged-rewind boundary, as `useSession().messages`.
 *
 * Use it with `useSession(…, { subscribeMessages: false })`: the lifecycle
 * host then stops re-rendering on every streamed delta, and only the component
 * that calls this hook (the transcript) does. Row objects keep their identity
 * while their message is unchanged, so a memoized row component re-renders
 * only for the message that is streaming.
 *
 * Read-only: it starts no request. The owning `useSession` still runs the
 * sync engine (fetch, stream, pollers).
 */
export function useSessionMessages(
  session: SessionMessagesSource,
  options: SessionMessagesOptions = {},
): MessageWithParts[] {
  const throttleMs = options.throttleMs && options.throttleMs > 0 ? options.throttleMs : 0;
  const ocSessionId = session.opencodeSessionId ?? '';
  const readableSessionId = useReadableSessionId(
    ocSessionId,
    `${session.projectId}/${session.sessionId}`,
  );
  const select = (state: ReturnType<typeof useSyncStore.getState>) =>
    readableSessionId ? selectSessionRows(state, readableSessionId) : EMPTY_ROWS;

  // Unpaced: a plain store subscription. Paced: the selector is constant, and
  // the effect below delivers rows on its own schedule.
  const liveRows = useSyncStore((state) => (throttleMs ? null : select(state)));
  const pacedRows = usePacedRows(readableSessionId, throttleMs);
  const rows = liveRows ?? pacedRows;

  const rewind = useSyncStore((state) => state.sessionRevert[ocSessionId] ?? null);
  return useMemo(() => messagesBeforeRewind(rows, rewind), [rows, rewind]);
}

function usePacedRows(readableSessionId: string, throttleMs: number): MessageWithParts[] {
  const read = () =>
    readableSessionId ? selectSessionRows(useSyncStore.getState(), readableSessionId) : EMPTY_ROWS;
  const [state, setState] = useState(() => ({ id: readableSessionId, rows: read() }));

  useEffect(() => {
    if (!throttleMs) return;
    let lastShownAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let shown: MessageWithParts[] | null = null;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const flush = () => {
      timer = null;
      const rows = read();
      if (rows === shown) return;
      shown = rows;
      lastShownAt = now();
      setState({ id: readableSessionId, rows });
    };
    // A new session id (or the switch to paced mode) shows its rows at once,
    // and does not count as a paced show: the first CHANGE after it is a
    // leading edge too.
    const initial = read();
    shown = initial;
    setState((prev) =>
      prev.id === readableSessionId && prev.rows === initial
        ? prev
        : { id: readableSessionId, rows: initial },
    );
    const unsubscribe = useSyncStore.subscribe(() => {
      if (read() === shown) return;
      const wait = throttleMs - (now() - lastShownAt);
      if (wait <= 0) {
        if (timer !== null) clearTimeout(timer);
        flush();
      } else if (timer === null) {
        timer = setTimeout(flush, wait);
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readableSessionId, throttleMs]);

  // Never hand back another session's rows while the effect catches up.
  return state.id === readableSessionId ? state.rows : read();
}
