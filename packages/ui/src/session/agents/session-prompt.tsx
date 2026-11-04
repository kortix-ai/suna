'use client';

import { createContext, useCallback, useContext } from 'react';
import { useSessionComposerPrefillStore } from '../composer/stores/session-composer-prefill-store';

/**
 * Send a prompt into the open session from a control that is not the composer
 * ("Save as workflow"). The session chat provides its own send path, so the
 * prompt goes out exactly as a typed one: a running turn is steered, an idle
 * session starts a turn, and the composer's draft is left alone.
 */
export type SessionPromptSend = (text: string) => unknown;

export const SessionPromptContext = createContext<SessionPromptSend | null>(null);

/**
 * The session's own send, or, outside a session chat, the composer prefill: the
 * text lands in the composer of `sessionId` for the person to send.
 */
export function useSessionPromptSend(sessionId: string | undefined): SessionPromptSend | null {
  const send = useContext(SessionPromptContext);
  const prefill = useCallback(
    (text: string) => {
      if (sessionId) useSessionComposerPrefillStore.getState().setPrefill(sessionId, text);
    },
    [sessionId],
  );
  if (send) return send;
  return sessionId ? prefill : null;
}
