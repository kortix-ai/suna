'use client';

import { prefetchSessionOpen } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

/**
 * How long the pointer must rest on a session row before its open read starts.
 *
 * A pointer that sweeps down the sidebar crosses every row on the way, and each
 * start costs one snapshot read (session row, turn, queue and the first
 * transcript window). A resting pointer reaches the click 100-300 ms after it
 * arrives, so a short rest keeps almost all of that head start and filters the
 * sweep. Focus and touch are explicit intent and start at once.
 */
export const SESSION_OPEN_INTENT_DELAY_MS = 80;

export interface SessionOpenIntent {
  pointerEnter: () => void;
  pointerLeave: () => void;
  /** Focus or touch: start now. */
  immediate: () => void;
  dispose: () => void;
}

/** Pure, so the rest delay and the cancel on leave are unit tests. */
export function createSessionOpenIntent(
  start: () => void,
  schedule: (callback: () => void, ms: number) => unknown = (callback, ms) =>
    setTimeout(callback, ms),
  cancel: (handle: unknown) => void = (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
): SessionOpenIntent {
  let pending: unknown = null;
  const clear = () => {
    if (pending === null) return;
    cancel(pending);
    pending = null;
  };
  return {
    pointerEnter: () => {
      if (pending !== null) return;
      pending = schedule(() => {
        pending = null;
        start();
      }, SESSION_OPEN_INTENT_DELAY_MS);
    },
    pointerLeave: clear,
    immediate: () => {
      clear();
      start();
    },
    dispose: clear,
  };
}

/**
 * Event handlers for a session link that start the session's open read on
 * intent (`prefetchSessionOpen`). The read is deduped per session in the SDK,
 * so repeated intent costs nothing. Read-only: it never wakes a sandbox.
 */
export function useSessionOpenIntent(projectId: string, sessionId: string) {
  const queryClient = useQueryClient();
  const intent = useMemo(
    () =>
      createSessionOpenIntent(() => {
        void prefetchSessionOpen(queryClient, projectId, sessionId);
      }),
    [queryClient, projectId, sessionId],
  );
  useEffect(() => () => intent.dispose(), [intent]);
  return {
    onMouseEnter: intent.pointerEnter,
    onMouseLeave: intent.pointerLeave,
    onFocus: intent.immediate,
    onTouchStart: intent.immediate,
  };
}
