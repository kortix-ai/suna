'use client';

import { useMemo } from 'react';
import type { FindMatch } from '../types';

/**
 * File/text search — stubbed for project-files (read-only).
 *
 * TODO: wire to project history/search once backend supports it
 */

export const fileSearchKeys = {
  files: (projectId: string, ref: string, query: string, type?: 'file' | 'directory', limit?: number) =>
    ['project-files', 'search', 'files', projectId, ref, query, type ?? 'all', limit ?? 50] as const,
  text: (projectId: string, ref: string, pattern: string) =>
    ['project-files', 'search', 'text', projectId, ref, pattern] as const,
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

export function useTextSearch(
  _pattern: string,
  _options?: { enabled?: boolean },
) {
  return useMemo(
    () => ({
      data: [] as FindMatch[],
      isLoading: false,
      isError: false,
      error: null as Error | null,
    }),
    [],
  );
}
