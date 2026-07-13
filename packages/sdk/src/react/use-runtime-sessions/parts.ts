'use client';

import { useMutation } from '@tanstack/react-query';
import type { Part } from '../../core/runtime/wire-types';

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
      void sessionId; void messageId; void partId; void part;
      throw new Error('ACP transcripts are append-only; message-part editing is not supported.');
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
      void sessionId; void messageId; void partId;
      throw new Error('ACP transcripts are append-only; message-part deletion is not supported.');
    },
    // SSE message.part.removed handles cache updates via sync store.
    // No onSuccess needed — eliminates unnecessary message refetch.
  });
}
