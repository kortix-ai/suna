'use client';

import { useQuery } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { searchLss } from '../api/lss-search';
import type { LssHit } from '../types';

export const lssSearchKeys = {
  search: (serverUrl: string, query: string) =>
    ['lss-search', serverUrl, query] as const,
};

/**
 * Semantic search over workspace files using LSS (BM25 + embeddings).
 * Uses the /lss/search endpoint on Kortix Master.
 *
 * Enable only when the user has typed a query (debounce upstream).
 */
export function useLssSearch(
  query: string,
  options?: { limit?: number; enabled?: boolean },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const limit = options?.limit ?? 10;

  return useQuery<LssHit[]>({
    queryKey: lssSearchKeys.search(serverUrl, query),
    queryFn: () => searchLss(query, { limit }),
    enabled: query.length >= 2 && options?.enabled !== false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 0, // don't retry on failure — LSS may not be available
  });
}
