'use client';

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fileListKeys, useRuntimeStore } from '@kortix/sdk/react';
import { listFiles } from '../api/runtime-files';
import { useFilesStore } from '@/features/file-browser/store/files-store';
import type { FileNode } from '@/features/file-browser/types';

// THE SAME KEYS THE LIVE STREAM INVALIDATES. The runtime's `file.edited`
// event invalidates `fileListKeys.all` from `@kortix/sdk/react`
// (use-opencode-events/handle-event.ts). This hook kept its own
// `['runtime-files', 'list']` family, so nothing the agent wrote reached the
// Files panel until it was closed and reopened — measured in a real browser
// on the pi-js dev stack 2026-09-10 (scratchpad ui-e2e.ts): the frames
// arrived, the tree stayed stale. One key family, imported.
export { fileListKeys };

/**
 * Fetch the directory listing for a path on the active OpenCode server.
 *
 * Uses GET /file?path=<path> which returns FileNode[].
 * Hidden (dot) files are filtered out unless showHidden is enabled in the store.
 */
export function useFileList(dirPath: string, options?: { enabled?: boolean }) {
  const serverUrl = useRuntimeStore((s) => s.getActiveWorkspaceUrl());
  const showHidden = useFilesStore((s) => s.showHidden);

  const query = useQuery<FileNode[]>({
    queryKey: fileListKeys.dir(serverUrl, dirPath),
    queryFn: () => listFiles(dirPath),
    enabled: !!dirPath && options?.enabled !== false,
    staleTime: 5_000,
    gcTime: 2 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error: Error) => {
      // Don't retry on 404 (dir doesn't exist) or access denied.
      // `error` is whatever the queryFn rejected with — React Query does not
      // guarantee it's an `Error` with a string `message`, so guard before
      // calling `.includes` (a non-string `message` previously crashed here
      // with `TypeError: t.message.includes is not a function`).
      const msg = typeof error?.message === 'string' ? error.message : '';
      if (msg.includes('404') || msg.includes('403')) return false;
      return failureCount < 3;
    },
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 5000),
  });

  // Filter hidden files client-side so the cache stays complete.
  // .kortix and .opencode are always shown — they are elevated system dirs.
  const data = useMemo(() => {
    if (!query.data) return query.data;
    if (showHidden) return query.data;
    return query.data.filter(
      (node) => !node.name.startsWith('.') || node.name === '.kortix' || node.name === '.opencode',
    );
  }, [query.data, showHidden]);

  return { ...query, data };
}

/**
 * Utility to imperatively invalidate all file list queries for the active server.
 */
export function useInvalidateFileList() {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveWorkspaceUrl());

  return (dirPath?: string) => {
    if (dirPath) {
      queryClient.invalidateQueries({
        queryKey: fileListKeys.dir(serverUrl, dirPath),
      });
    } else {
      queryClient.invalidateQueries({
        queryKey: fileListKeys.all,
      });
    }
  };
}
