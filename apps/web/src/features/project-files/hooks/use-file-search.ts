'use client';

import { useQuery } from '@tanstack/react-query';
import { searchFileContents, searchFiles } from '../api/runtime-files';
import { useProjectContext } from '../context';
import type { FileContentMatch } from '../explorer-source';

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
  content: (projectId: string, ref: string, query: string, limit: number) =>
    ['project-files', 'search', 'content', projectId, ref, query, limit] as const,
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

/**
 * Text search over every file at the active project's ref, served by
 * GET /v1/projects/:projectId/files/search?content=1 (`git grep`).
 */
export function useFileContentSearch(
  query: string,
  options?: { limit?: number; enabled?: boolean },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';
  const q = query.trim();
  const limit = options?.limit ?? 50;

  return useQuery<FileContentMatch[]>({
    queryKey: fileSearchKeys.content(projectId, ref, q, limit),
    queryFn: () => searchFileContents(projectId, ref, q, { limit }),
    enabled: !!projectId && !!ref && !!q && options?.enabled !== false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
