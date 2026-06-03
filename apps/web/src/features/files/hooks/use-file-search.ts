'use client';

import { useQuery } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { searchWorkspaceFilePaths } from '../search/workspace-search-service';

const fileSearchKeys = {
  files: (serverUrl: string, query: string, type?: 'file' | 'directory', limit?: number) =>
    ['opencode-files', 'search', 'files', serverUrl, query, type ?? 'all', limit ?? 50] as const,
};

/**
 * Search for files and directories by name (fuzzy match).
 * Uses GET /find/file?query=<q>.
 *
 * Enable only when the user has typed a query (debounce upstream).
 */
export function useFileSearch(
  query: string,
  options?: { type?: 'file' | 'directory'; limit?: number; enabled?: boolean },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const limit = options?.limit ?? 50;

  return useQuery<string[]>({
    queryKey: fileSearchKeys.files(serverUrl, query, options?.type, limit),
    queryFn: () => searchWorkspaceFilePaths(query, { type: options?.type, limit }),
    enabled: query.length > 0 && options?.enabled !== false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
