'use client';

import { useQuery } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import {
  getWorkspaceFileIndex,
} from '../search/workspace-search-service';
import { findFilesInDirectory } from '../api/opencode-files';
import type { WorkspaceSearchEntry } from '../search/workspace-search-core';

export function useWorkspaceFileIndex(options?: { enabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<WorkspaceSearchEntry[]>({
    queryKey: ['opencode-files', 'workspace-index', serverUrl],
    queryFn: () => getWorkspaceFileIndex(),
    enabled: options?.enabled !== false,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useProjectFileIndex(
  projectPath: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const enabled = !!projectPath && projectPath !== '/' && options?.enabled !== false;

  return useQuery<string[]>({
    queryKey: ['opencode-files', 'project-file-paths', serverUrl, projectPath ?? ''],
    queryFn: () => findFilesInDirectory(projectPath as string),
    enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
