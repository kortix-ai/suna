'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listFiles } from '../api/opencode-files';
import { useProjectContext } from '../context';
import type { FileNode } from '../types';

export const fileListKeys = {
  all: ['project-files', 'list'] as const,
  dir: (projectId: string, ref: string, dirPath: string) =>
    ['project-files', 'list', projectId, ref, dirPath] as const,
};

/**
 * Fetch the directory listing for a path on the active project.
 *
 * Uses GET /v1/projects/:projectId/files (recursive list, filtered client-side
 * down to immediate children of `dirPath`).
 */
export function useFileList(
  dirPath: string,
  options?: { enabled?: boolean },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  return useQuery<FileNode[]>({
    queryKey: fileListKeys.dir(projectId, ref, dirPath),
    queryFn: () => listFiles(projectId, ref, dirPath),
    enabled: !!projectId && !!ref && !!dirPath && options?.enabled !== false,
    staleTime: 5_000,
    gcTime: 2 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error: Error) => {
      if (error.message.includes('404') || error.message.includes('403')) return false;
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 5000),
  });
}

export function useInvalidateFileList() {
  const queryClient = useQueryClient();
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  return (dirPath?: string) => {
    if (dirPath) {
      queryClient.invalidateQueries({
        queryKey: fileListKeys.dir(projectId, ref, dirPath),
      });
    } else {
      queryClient.invalidateQueries({
        queryKey: fileListKeys.all,
      });
    }
  };
}
