'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readFile } from '../api/opencode-files';
import { useProjectContext } from '../context';
import type { FileContent } from '../types';

export const fileContentKeys = {
  all: ['project-files', 'content'] as const,
  file: (projectId: string, ref: string, filePath: string) =>
    ['project-files', 'content', projectId, ref, filePath] as const,
};

/**
 * Fetch the content of a single file from the active project's git ref.
 */
export function useFileContent(
  filePath: string | null,
  options?: { enabled?: boolean; staleTime?: number },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  return useQuery<FileContent>({
    queryKey: filePath ? fileContentKeys.file(projectId, ref, filePath) : [],
    queryFn: () => readFile(projectId, ref, filePath!),
    enabled: !!projectId && !!ref && !!filePath && options?.enabled !== false,
    staleTime: options?.staleTime ?? 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error: Error) => {
      const msg = error.message.toLowerCase();
      if (msg.includes('404') || msg.includes('403') || msg.includes('not found') || msg.includes('access denied')) return false;
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 5000),
  });
}

export function useInvalidateFileContent() {
  const queryClient = useQueryClient();
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  return (filePath?: string) => {
    if (filePath) {
      queryClient.invalidateQueries({
        queryKey: fileContentKeys.file(projectId, ref, filePath),
      });
    } else {
      queryClient.invalidateQueries({
        queryKey: fileContentKeys.all,
      });
    }
  };
}
