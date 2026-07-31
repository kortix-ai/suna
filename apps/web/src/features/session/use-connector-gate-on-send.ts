'use client';

/**
 * A turn refused for a missing connector opens the connect gate, in the session.
 *
 * The platform refuses these turns before the sandbox sees them — nothing
 * streamed, nothing was spent — but the refusal had nowhere to go: `send` does
 * not throw, it parks a `sendError`, and nothing in the web app read one. So the
 * single failure with an obvious remedy surfaced as a dead generic error, and
 * before the pre-flight existed at all the agent simply answered "Still no
 * active connectors" mid-turn.
 *
 * The gate this opens is the SAME one a connector-blocked session CREATE uses.
 * Two dialogs for one problem would drift, and the create flow's version already
 * knows how to mint a connect link, poll for the connection, and retry.
 */

import { useEffect, useRef } from 'react';

import { useConnectorGateStore } from '@/stores/connector-gate-store';
import type { KortixSendError } from '@kortix/sdk/react';

export function useConnectorGateOnSend(input: {
  projectId: string | undefined;
  /** `session.pending` — the optimistic text of the turn now in flight. */
  pending: string | null | undefined;
  sendError: KortixSendError | null | undefined;
  resend: (text: string) => void;
}): void {
  const openConnectorGate = useConnectorGateStore((state) => state.openConnectorGate);
  const { projectId, pending, sendError, resend } = input;

  // The refused text. `pending` is nulled the moment the send fails, so it is
  // captured while the turn is still in flight — otherwise the user connects
  // their account, the gate retries, and re-sends nothing. Losing the message
  // they typed would be a worse outcome than the error they started with.
  const lastAttempt = useRef<string | null>(null);
  if (pending) lastAttempt.current = pending;

  const resendRef = useRef(resend);
  resendRef.current = resend;

  // Keyed on the error identity so one refusal opens the gate once, rather than
  // re-opening it on every unrelated re-render while the error is still set.
  const handled = useRef<KortixSendError | null>(null);

  useEffect(() => {
    if (!sendError || sendError.kind !== 'connector') return;
    if (!projectId || !sendError.connectors?.length) return;
    if (handled.current === sendError) return;
    handled.current = sendError;

    const text = lastAttempt.current;
    openConnectorGate({
      projectId,
      connectorProfiles: sendError.connectors,
      // The gate runs this once every named connector is connected.
      retry: () => {
        if (text) resendRef.current(text);
      },
    });
  }, [projectId, sendError, openConnectorGate]);
}
