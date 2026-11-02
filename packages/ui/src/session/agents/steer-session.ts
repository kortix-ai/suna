'use client';

import { createSessionPrompt, mintWireMessageId } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';

/**
 * Send a message to another session through the API's prompt route, as a steer:
 * a running turn reads it at its next step, an idle session starts a turn. It
 * needs no runtime of its own, so a host can message a sub-agent or a board row
 * from beside the session that owns the app's runtime.
 */
export function useSteerSession(projectId: string | undefined, options: { onSent?: () => void; onError?: (error: unknown) => void } = {}) {
  return useMutation({
    mutationFn: async ({ sessionId, text }: { sessionId: string; text: string }) => {
      if (!projectId) throw new Error('No project');
      // Minted with no transcript to place it against: the server places it at delivery.
      const messageId = mintWireMessageId();
      return createSessionPrompt(projectId, sessionId, {
        clientMessageId: messageId,
        messageId,
        remintOnDelivery: true,
        delivery: 'steer',
        parts: [{ type: 'text', text }],
        clientSentAtMs: Date.now(),
      });
    },
    onSuccess: () => options.onSent?.(),
    onError: (error) => options.onError?.(error),
  });
}
