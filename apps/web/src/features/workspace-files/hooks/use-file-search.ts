'use client';

import { useMemo } from 'react';

/**
 * File search — stubbed for workspace-files (read-only).
 *
 * TODO: wire to workspace history/search once backend supports it
 */

export const fileSearchKeys = {
  files: (workspaceId: string, ref: string, query: string, type?: 'file' | 'directory', limit?: number) =>
    ['workspace-files', 'search', 'files', workspaceId, ref, query, type ?? 'all', limit ?? 50] as const,
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
