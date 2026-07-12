'use client';

/**
 * Headless React binding over `classifyTurn` (`@kortix/sdk/turns`) — the
 * memoized, ready-to-render view model for a session's message list.
 *
 * Deliberately dumb: it holds no state of its own and renders nothing. A host
 * passes it the same `messages` array `useSession()` returns; it hands back
 * one `TurnView` per message, recomputed only when the `messages` reference
 * changes (React Query / the sync store already give a stable reference
 * between renders when nothing changed, so this is cheap in the steady
 * state).
 */

import { useMemo } from 'react';
import type { ClassifiedPart, TurnError } from '../../core/turns';
import { classifyTurn } from '../../core/turns';
import type { MessageWithParts } from '../use-runtime-sessions';

export interface TurnView {
  /** The original message this view was classified from — kept around so a
   *  host can still read `message.info.role`, `.id`, etc. without a second
   *  lookup. */
  message: MessageWithParts;
  parts: ClassifiedPart[];
  error?: TurnError;
  isEmpty: boolean;
}

/**
 * Classify every message in a session's message list into a `TurnView`.
 * One `TurnView` per message (NOT per user/assistant turn-group — pair with
 * `groupMessagesIntoTurns` from `@kortix/sdk/turns` first if a host wants
 * grouped turns instead of a flat per-message list).
 */
export function useChatTurns(messages: MessageWithParts[]): TurnView[] {
  return useMemo(
    () =>
      messages.map((message) => {
        const { parts, error, isEmpty } = classifyTurn(message);
        return { message, parts, error, isEmpty };
      }),
    [messages],
  );
}
