'use client';

import type { GitFileStatus } from '../types';

/**
 * Project-files view: no "uncommitted changes" concept — files are already
 * committed git tree entries. We expose the same hook surface but it always
 * resolves to an empty list, and `buildGitStatusMap` is kept verbatim so
 * the file-tree's status-tinting code keeps compiling.
 */

export const gitStatusKeys = {
  all: ['project-files', 'git-status'] as const,
  status: (projectId: string, ref: string) =>
    ['project-files', 'git-status', projectId, ref] as const,
};

export function useGitStatus(_options?: { enabled?: boolean }) {
  return {
    data: [] as GitFileStatus[],
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: async () => ({ data: [] as GitFileStatus[] } as any),
  };
}

export function buildGitStatusMap(
  statuses: GitFileStatus[] | undefined,
): Map<string, GitFileStatus['status']> {
  const map = new Map<string, GitFileStatus['status']>();
  if (!statuses) return map;
  for (const file of statuses) {
    map.set(file.path, file.status);
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/');
      if (!map.has(dirPath)) {
        map.set(dirPath, 'modified');
      }
    }
  }
  return map;
}
