'use client';

import { useMutation } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Part } from '@opencode-ai/sdk/v2/client';
import { unwrap } from './shared';

// ============================================================================
// Part Edit / Delete Hooks
// ============================================================================

/**
 * Update a message part (e.g. edit text content).
 * Uses `client.part.update()` — available in SDK v2.
 * SSE `message.part.updated` events handle cache updates automatically.
 */
export function useUpdatePart() {
  return useMutation({
    mutationFn: async ({
      sessionId,
      messageId,
      partId,
      part,
    }: {
      sessionId: string;
      messageId: string;
      partId: string;
      part: Partial<Part>;
    }) => {
      const client = getClient();
      const result = await client.part.update({
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
        part: part as Part,
      });
      return unwrap(result) as Part;
    },
    // SSE message.part.updated handles cache updates via sync store.
    // No onSuccess needed — eliminates unnecessary message refetch.
  });
}

/**
 * Delete a message part.
 * Uses `client.part.delete()` — available in SDK v2.
 * SSE `message.part.removed` events handle cache updates automatically.
 */
export function useDeletePart() {
  return useMutation({
    mutationFn: async ({
      sessionId,
      messageId,
      partId,
    }: {
      sessionId: string;
      messageId: string;
      partId: string;
    }) => {
      const client = getClient();
      const result = await client.part.delete({
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
      });
      return unwrap(result);
    },
    // SSE message.part.removed handles cache updates via sync store.
    // No onSuccess needed — eliminates unnecessary message refetch.
  });
}
