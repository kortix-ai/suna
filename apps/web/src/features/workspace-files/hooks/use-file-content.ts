'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readFile } from '../api/runtime-files';
import { useWorkspaceContext } from '../context';
import type { FileContent } from '@/features/file-browser/types';

export const fileContentKeys = {
  all: ['workspace-files', 'content'] as const,
  file: (workspaceId: string, ref: string, filePath: string) =>
    ['workspace-files', 'content', workspaceId, ref, filePath] as const,
};

/**
 * Fetch the content of a single file from the active project's git ref.
 */
export function useFileContent(
  filePath: string | null,
  options?: { enabled?: boolean; staleTime?: number },
) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const ref = ctx?.ref ?? '';

  return useQuery<FileContent>({
    queryKey: filePath ? fileContentKeys.file(workspaceId, ref, filePath) : [],
    queryFn: () => readFile(workspaceId, ref, filePath!),
    enabled: !!workspaceId && !!ref && !!filePath && options?.enabled !== false,
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
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const ref = ctx?.ref ?? '';

  return (filePath?: string) => {
    if (filePath) {
      queryClient.invalidateQueries({
        queryKey: fileContentKeys.file(workspaceId, ref, filePath),
      });
    } else {
      queryClient.invalidateQueries({
        queryKey: fileContentKeys.all,
      });
    }
  };
}
