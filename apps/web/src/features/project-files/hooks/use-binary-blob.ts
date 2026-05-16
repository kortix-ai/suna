'use client';

import { useMemo } from 'react';

/**
 * Binary blob loader — stubbed for project-files (read-only).
 *
 * Project API returns text content only; rich-media preview (PDF / docx /
 * video) is unavailable. Consumers see a "preview not available" state.
 *
 * TODO: wire to project history/search once backend supports it
 */

export const binaryBlobKeys = {
  all: ['project-files', 'binary-blob'] as const,
  file: (projectId: string, ref: string, filePath: string) =>
    ['project-files', 'binary-blob', projectId, ref, filePath] as const,
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
      error: 'Binary preview not available for project files',
    }),
    [],
  );
}
