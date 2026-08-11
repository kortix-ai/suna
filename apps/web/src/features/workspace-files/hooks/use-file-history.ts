'use client';

import { useQuery } from '@tanstack/react-query';
import {
  getFileCommitDiff,
  getFileHistory,
} from '../api/git-history';
import { useWorkspaceContext } from '../context';
import type { FileCommitDiff, FileHistoryResult } from '@/features/file-browser/types';

export const fileHistoryKeys = {
  all: ['workspace-files', 'history'] as const,
  file: (workspaceId: string, ref: string, filePath: string) =>
    ['workspace-files', 'history', workspaceId, ref, filePath] as const,
  filePaged: (
    workspaceId: string,
    ref: string,
    filePath: string,
    skip: number,
    limit: number,
  ) => ['workspace-files', 'history', workspaceId, ref, filePath, skip, limit] as const,
  commitDiff: (
    workspaceId: string,
    ref: string,
    filePath: string,
    commitHash: string,
  ) => ['workspace-files', 'history', 'diff', workspaceId, ref, filePath, commitHash] as const,
  fileAtCommit: (
    workspaceId: string,
    ref: string,
    filePath: string,
    commitHash: string,
  ) => ['workspace-files', 'history', 'content', workspaceId, ref, filePath, commitHash] as const,
};

/**
 * Load checkpoint (commit) history for a single file at the active version.
 * Returns an empty `FileHistoryResult` when the workspace context is missing or
 * the query is disabled — callers can render skeletons / empty states without
 * null-checks.
 */
export function useFileHistory(
  filePath: string | null,
  options?: { enabled?: boolean; limit?: number; skip?: number },
) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const ref = ctx?.ref ?? '';
  const limit = options?.limit ?? 50;
  const skip = options?.skip ?? 0;

  const query = useQuery<FileHistoryResult>({
    queryKey: filePath
      ? fileHistoryKeys.filePaged(workspaceId, ref, filePath, skip, limit)
      : fileHistoryKeys.all,
    queryFn: () => getFileHistory(workspaceId, ref, filePath as string, { limit, skip }),
    enabled: Boolean(workspaceId && ref && filePath) && options?.enabled !== false,
    staleTime: 30_000,
  });

  return query;
}

export function useFileCommitDiff(
  filePath: string | null,
  commitHash: string | null,
  options?: { enabled?: boolean },
) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const ref = ctx?.ref ?? '';

  return useQuery<FileCommitDiff>({
    queryKey:
      filePath && commitHash
        ? fileHistoryKeys.commitDiff(workspaceId, ref, filePath, commitHash)
        : ['workspace-files', 'history', 'diff', 'idle'],
    queryFn: () => getFileCommitDiff(workspaceId, filePath as string, commitHash as string),
    enabled:
      Boolean(workspaceId && filePath && commitHash) && options?.enabled !== false,
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
