'use client';

import { useQuery } from '@tanstack/react-query';
import {
  getFileCommitDiff,
  getFileHistory,
} from '../api/git-history';
import { useProjectContext } from '../context';
import type { FileCommitDiff, FileHistoryResult } from '../types';

export const fileHistoryKeys = {
  all: ['project-files', 'history'] as const,
  file: (projectId: string, ref: string, filePath: string) =>
    ['project-files', 'history', projectId, ref, filePath] as const,
  filePaged: (
    projectId: string,
    ref: string,
    filePath: string,
    skip: number,
    limit: number,
  ) => ['project-files', 'history', projectId, ref, filePath, skip, limit] as const,
  commitDiff: (
    projectId: string,
    ref: string,
    filePath: string,
    commitHash: string,
  ) => ['project-files', 'history', 'diff', projectId, ref, filePath, commitHash] as const,
  fileAtCommit: (
    projectId: string,
    ref: string,
    filePath: string,
    commitHash: string,
  ) => ['project-files', 'history', 'content', projectId, ref, filePath, commitHash] as const,
};

/**
 * Load checkpoint (commit) history for a single file at the active version.
 * Returns an empty `FileHistoryResult` when the project context is missing or
 * the query is disabled — callers can render skeletons / empty states without
 * null-checks.
 */
export function useFileHistory(
  filePath: string | null,
  options?: { enabled?: boolean; limit?: number; skip?: number },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';
  const limit = options?.limit ?? 50;
  const skip = options?.skip ?? 0;

  const query = useQuery<FileHistoryResult>({
    queryKey: filePath
      ? fileHistoryKeys.filePaged(projectId, ref, filePath, skip, limit)
      : fileHistoryKeys.all,
    queryFn: () => getFileHistory(projectId, ref, filePath as string, { limit, skip }),
    enabled: Boolean(projectId && ref && filePath) && options?.enabled !== false,
    staleTime: 30_000,
  });

  return query;
}

export function useFileCommitDiff(
  filePath: string | null,
  commitHash: string | null,
  options?: { enabled?: boolean },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  return useQuery<FileCommitDiff>({
    queryKey:
      filePath && commitHash
        ? fileHistoryKeys.commitDiff(projectId, ref, filePath, commitHash)
        : ['project-files', 'history', 'diff', 'idle'],
    queryFn: () => getFileCommitDiff(projectId, filePath as string, commitHash as string),
    enabled:
      Boolean(projectId && filePath && commitHash) && options?.enabled !== false,
    staleTime: 5 * 60_000,
  });
}

/** No-op for now — file blob at commit is not surfaced in the UI yet. */
export function useFileAtCommit(
  _filePath: string | null,
  _commitHash: string | null,
  _options?: { enabled?: boolean },
) {
  return {
    data: '',
    isLoading: false,
    isError: false,
    error: null as Error | null,
  };
}
