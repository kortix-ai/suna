'use client';

import { useMemo } from 'react';
import type { LssHit } from '../types';

/**
 * LSS semantic search — stubbed for project-files (read-only).
 *
 * TODO: wire to project history/search once backend supports it
 */

export const lssSearchKeys = {
  search: (projectId: string, ref: string, query: string) =>
    ['lss-search', projectId, ref, query] as const,
};

export function useLssSearch(
  _query: string,
  _options?: { limit?: number; enabled?: boolean },
) {
  return useMemo(
    () => ({
      data: [] as LssHit[],
      isLoading: false,
      isError: false,
      error: null as Error | null,
    }),
    [],
  );
}
