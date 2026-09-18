'use client';

import type { FileContent } from '@/features/file-browser/types';
import { isSandboxNotReadyError } from '@kortix/sdk';
import { useRuntimeStore } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readRuntimeFileWithRetry } from '../api/runtime-file-read';
import { readFile } from '../api/runtime-files';
import { sandboxWakingRefetchInterval } from './file-read-retry';
import { useServerHealth } from './use-server-health';
import { isSystemDirectoryPath } from './system-dir';

export const fileContentKeys = {
  all: ['runtime-files', 'content'] as const,
  file: (serverUrl: string, filePath: string) =>
    ['runtime-files', 'content', serverUrl, filePath] as const,
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
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());
  // The control plane answered the probe from the session row: the box is
  // asleep and no read can wake it, so the re-read poll below must stop.
  const { parked } = useServerHealth();

  return useQuery<FileContent>({
    queryKey: filePath ? fileContentKeys.file(serverUrl, filePath) : [],
    queryFn: ({ signal }) =>
      readRuntimeFileWithRetry(filePath!, () => readFile(filePath!), undefined, signal),
    enabled: !!filePath && !isSystemDirectoryPath(filePath) && options?.enabled !== false,
    staleTime: options?.staleTime ?? 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    // A readiness 503 from a BOOTING sandbox is a pending state, not a
    // failure: keep polling until the box is active so the file loads on its own.
    // A PARKED box is not coming up on its own, so that same poll would never
    // end — see `sandboxWakingRefetchInterval`.
    refetchInterval: (query) => sandboxWakingRefetchInterval(query.state.error, parked),
  });
}

/**
 * Utility to imperatively invalidate file content queries.
 */
export function useInvalidateFileContent() {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

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
