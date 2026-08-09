'use client';

import { searchWorkspaceFiles } from '@/features/files';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from './use-debounced-value';

/**
 * Local to apps/web on purpose. `qk` lives in `packages/sdk`, which is
 * published to npm and gates every export on a snapshot test — a host-only
 * mention cache does not belong in that contract.
 */
const composerKeys = {
  fileSearch: (query: string) => ['web', 'composer', 'file-search', query] as const,
};

/**
 * File results for the `@` menu.
 *
 * Replaces session-chat-input.tsx:602-656 entirely:
 *  - `fileSearchTimer`   → useDebouncedValue on the key
 *  - `fileSearchSeq`     → the query key itself; a stale response resolves
 *                          under its own key and is never applied to a newer one
 *  - `fileResultsCache`  → keepPreviousData + a 30s staleTime, shared
 *                          process-wide instead of per-composer
 */
export function useFileSearch(query: string, enabled: boolean) {
  const debounced = useDebouncedValue(query, 150);

  const { data, isFetching } = useQuery({
    queryKey: composerKeys.fileSearch(debounced),
    queryFn: () => searchWorkspaceFiles(debounced),
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  return { files: data ?? [], isLoading: isFetching && !data };
}
