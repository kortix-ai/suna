'use client';

import { useMemo } from 'react';

/**
 * Binary blob loader — stubbed for workspace-files (read-only).
 *
 * Project API returns text content only; rich-media preview (PDF / docx /
 * video) is unavailable. Consumers see a "preview not available" state.
 *
 * TODO: wire to workspace history/search once backend supports it
 */

export const binaryBlobKeys = {
  all: ['workspace-files', 'binary-blob'] as const,
  file: (workspaceId: string, ref: string, filePath: string) =>
    ['workspace-files', 'binary-blob', workspaceId, ref, filePath] as const,
};

export function useBinaryBlob(_filePath: string | null): {
  blobUrl: string | null;
  blob: Blob | null;
  isLoading: boolean;
  error: string | null;
} {
  return useMemo(
    () => ({
      blobUrl: null,
      blob: null,
      isLoading: false,
      error: 'Binary preview not available for workspace files',
    }),
    [],
  );
}
