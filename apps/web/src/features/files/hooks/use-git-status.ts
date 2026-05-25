'use client';

import { useQuery } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { getFileStatus } from '../api/opencode-files';
import type { GitFileStatus } from '../types';
import { useCurrentProject, useServerHealth } from './use-server-health';

export const gitStatusKeys = {
  all: ['opencode-files', 'git-status'] as const,
  status: (serverUrl: string) =>
    ['opencode-files', 'git-status', serverUrl] as const,
};

/**
 * Fetch the git file status for the current project.
 * Returns an array of files with uncommitted changes (added, modified, deleted).
 */
export function useGitStatus(options?: { enabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const { data: health } = useServerHealth();
  const { data: project } = useCurrentProject({
    enabled: options?.enabled !== false,
  });
  const enabled =
    options?.enabled !== false &&
    health?.healthy === true &&
    project?.vcs === 'git';

  return useQuery<GitFileStatus[]>({
    queryKey: gitStatusKeys.status(serverUrl),
    queryFn: () => getFileStatus(),
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 0,
  });
}

/**
 * Build a lookup map from file path to git status.
 * Also computes directory statuses: a directory is "modified" if any
 * descendant file has changes.
 */
export function buildGitStatusMap(
  statuses: GitFileStatus[] | undefined,
): Map<string, GitFileStatus['status']> {
  const map = new Map<string, GitFileStatus['status']>();
  if (!statuses) return map;

  // git status returns repo-relative paths ("site/index.html"), but the explorer
  // keys lookups by the file node's path, which is the /workspace-absolute form
  // ("/workspace/site/index.html"). Index BOTH so dots match regardless.
  const setBoth = (p: string, status: GitFileStatus['status'], overwrite = true) => {
    const abs = p.startsWith('/workspace/') ? p : `/workspace/${p}`;
    if (overwrite || !map.has(p)) map.set(p, status);
    if (overwrite || !map.has(abs)) map.set(abs, status);
  };

  for (const file of statuses) {
    // Direct file status
    setBoth(file.path, file.status);

    // Propagate to ancestor directories (don't clobber a real file status)
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/');
      setBoth(dirPath, 'modified', false);
    }
  }

  return map;
}
