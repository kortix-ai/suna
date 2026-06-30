'use client';

import { useMemo } from 'react';

/**
 * File search — stubbed for project-files (read-only).
 *
 * TODO: wire to project history/search once backend supports it
 */

export const fileSearchKeys = {
  files: (projectId: string, ref: string, query: string, type?: 'file' | 'directory', limit?: number) =>
    ['project-files', 'search', 'files', projectId, ref, query, type ?? 'all', limit ?? 50] as const,
};

export function useFileSearch(
  _query: string,
  _options?: { type?: 'file' | 'directory'; limit?: number; enabled?: boolean },
) {
  return useMemo(
    () => ({
      data: [] as string[],
      isLoading: false,
      isError: false,
      error: null as Error | null,
    }),
    [],
  );
}
