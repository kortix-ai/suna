'use client';

import { useQuery } from '@tanstack/react-query';
import { searchFiles } from '../api/runtime-files';
import { useProjectContext } from '../context';

export const fileSearchKeys = {
  files: (
    projectId: string,
    ref: string,
    query: string,
    type?: 'file' | 'directory',
    limit?: number,
  ) =>
    [
      'project-files',
      'search',
      'files',
      projectId,
      ref,
      query,
      type ?? 'all',
      limit ?? 50,
    ] as const,
};

/**
 * Filename search on the active project's ref, served by
 * GET /v1/projects/:projectId/files/search over the whole repository.
 * The server matches files only, so a directory-only search returns nothing.
 */
export function useFileSearch(
  query: string,
  options?: { type?: 'file' | 'directory'; limit?: number; enabled?: boolean },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';
  const q = query.trim();
  const limit = options?.limit ?? 50;

  return useQuery<string[]>({
    queryKey: fileSearchKeys.files(projectId, ref, q, options?.type, limit),
    queryFn: () => searchFiles(projectId, ref, q, { limit }),
    enabled:
      !!projectId && !!ref && !!q && options?.type !== 'directory' && options?.enabled !== false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
