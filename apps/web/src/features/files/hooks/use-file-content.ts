'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { readFile } from '../api/opencode-files';
import type { FileContent } from '../types';

export const fileContentKeys = {
  all: ['opencode-files', 'content'] as const,
  file: (serverUrl: string, filePath: string) =>
    ['opencode-files', 'content', serverUrl, filePath] as const,
};

/**
 * Fetch the content of a single file from the active OpenCode server.
 *
 * Uses GET /file/content?path=<path> which returns FileContent.
 * Text files return plain content; images/binaries return base64-encoded content.
 */
export function useFileContent(
  filePath: string | null,
  options?: { enabled?: boolean; staleTime?: number },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<FileContent>({
    queryKey: filePath ? fileContentKeys.file(serverUrl, filePath) : [],
    queryFn: () => readFile(filePath!),
    enabled: !!filePath && options?.enabled !== false,
    staleTime: options?.staleTime ?? 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error: Error) => {
      const msg = error.message.toLowerCase();
      // Don't retry permanent failures (not found, access denied)
      if (msg.includes('404') || msg.includes('403') || msg.includes('not found') || msg.includes('access denied')) return false;
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 5000),
  });
}

/**
 * Utility to imperatively invalidate file content queries.
 */
export function useInvalidateFileContent() {
  const queryClient = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return (filePath?: string) => {
    if (filePath) {
      queryClient.invalidateQueries({
        queryKey: fileContentKeys.file(serverUrl, filePath),
      });
    } else {
      queryClient.invalidateQueries({
        queryKey: fileContentKeys.all,
      });
    }
  };
}
