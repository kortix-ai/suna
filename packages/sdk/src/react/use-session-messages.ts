'use client';

import { useEffect, useMemo, useState } from 'react';

import { useSyncStore, type MessageWithParts } from '../browser/stores/sync-store';
import { messagesBeforeRewind } from '../core/session/rewind';
import { selectSessionRows, useReadableSessionId } from './session-transcript-subscription';

/** The identity `useSessionMessages` needs from a `useSession` result. */
export interface SessionMessagesSource {
  projectId: string;
  sessionId: string;
  /** The runtime's root session id, or null while resolving. */
  runtimeSessionId?: string | null;
  /** @deprecated Renamed to `runtimeSessionId`, which wins when both are set. Removed in the next major. */
  opencodeSessionId?: string | null;
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
  const ocSessionId = session.runtimeSessionId ?? session.opencodeSessionId ?? '';
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
  return usePacedStoreValue(
    (state) => (readableSessionId ? selectSessionRows(state, readableSessionId) : EMPTY_ROWS),
    readableSessionId,
    throttleMs,
  );
}

/**
 * Internal (not in the barrel): `read(state)` delivered at most once per `throttleMs`
 * (leading and trailing edge, the latest value always lands). `read` must return the same
 * object for an unchanged value; a new `key` shows its value at once. Unpaced (0) callers
 * subscribe with `useSyncStore(read)` instead.
 */
export function usePacedStoreValue<T>(
  read: (state: ReturnType<typeof useSyncStore.getState>) => T,
  key: string,
  throttleMs: number,
): T {
  const current = () => read(useSyncStore.getState());
  const [state, setState] = useState(() => ({ key, value: current() }));

  useEffect(() => {
    if (!throttleMs) return;
    let lastShownAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let shown: T;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const flush = () => {
      timer = null;
      const value = current();
      if (value === shown) return;
      shown = value;
      lastShownAt = now();
      setState({ key, value });
    };
    // A new key (or the switch to paced mode) shows its value at once, and
    // does not count as a paced show: the first CHANGE after it is a leading
    // edge too.
    const initial = current();
    shown = initial;
    setState((prev) => (prev.key === key && prev.value === initial ? prev : { key, value: initial }));
    const unsubscribe = useSyncStore.subscribe(() => {
      if (current() === shown) return;
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
  }, [key, throttleMs]);

  // Never hand back another key's value while the effect catches up.
  return state.key === key ? state.value : current();
}
