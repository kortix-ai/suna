'use client';

import { useQuery } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { findText } from '../api/opencode-files';
import type { FindMatch } from '../types';
import { searchWorkspaceFilePaths } from '../search/workspace-search-service';

export const fileSearchKeys = {
  files: (serverUrl: string, query: string, type?: 'file' | 'directory', limit?: number) =>
    ['opencode-files', 'search', 'files', serverUrl, query, type ?? 'all', limit ?? 50] as const,
  text: (serverUrl: string, pattern: string) =>
    ['opencode-files', 'search', 'text', serverUrl, pattern] as const,
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

/**
 * Search for text content across files (ripgrep).
 * Uses GET /find?pattern=<pat>.
 */
export function useTextSearch(
  pattern: string,
  options?: { enabled?: boolean },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<FindMatch[]>({
    queryKey: fileSearchKeys.text(serverUrl, pattern),
    queryFn: () => findText(pattern),
    enabled: pattern.length > 0 && options?.enabled !== false,
    staleTime: 10_000,
    gcTime: 2 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
