'use client';

import { useQuery } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { getFileHistory, getFileCommitDiff, getFileAtCommit } from '../api/git-history';
import type { FileHistoryResult, FileCommitDiff } from '@/features/file-browser/types';

export const fileHistoryKeys = {
  all: ['runtime-files', 'history'] as const,
  file: (serverUrl: string, filePath: string) =>
    ['runtime-files', 'history', serverUrl, filePath] as const,
  filePaged: (serverUrl: string, filePath: string, skip: number, limit: number) =>
    ['runtime-files', 'history', serverUrl, filePath, skip, limit] as const,
  commitDiff: (serverUrl: string, filePath: string, commitHash: string) =>
    ['runtime-files', 'history', 'diff', serverUrl, filePath, commitHash] as const,
  fileAtCommit: (serverUrl: string, filePath: string, commitHash: string) =>
    ['runtime-files', 'history', 'content', serverUrl, filePath, commitHash] as const,
};

/**
 * Fetch the git commit history for a specific file.
 *
 * Returns a paginated list of commits that touched the file,
 * ordered newest-first, with support for `--follow` to track renames.
 */
export function useFileHistory(
  filePath: string | null,
  options?: {
    enabled?: boolean;
    limit?: number;
    skip?: number;
  },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const limit = options?.limit ?? 50;
  const skip = options?.skip ?? 0;

  return useQuery<FileHistoryResult>({
    queryKey: filePath
      ? fileHistoryKeys.filePaged(serverUrl, filePath, skip, limit)
      : [],
    queryFn: () => getFileHistory(filePath!, limit, skip),
    enabled: !!filePath && options?.enabled !== false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error: Error) => {
      // Don't retry on "not a git repo" or file-not-found errors
      if (
        error.message.includes('not a git repository') ||
        error.message.includes('does not exist')
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

/**
 * Fetch the diff for a specific commit affecting a file.
 *
 * Returns the unified diff patch, before/after content,
 * and line addition/deletion counts.
 */
export function useFileCommitDiff(
  filePath: string | null,
  commitHash: string | null,
  options?: { enabled?: boolean },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<FileCommitDiff>({
    queryKey:
      filePath && commitHash
        ? fileHistoryKeys.commitDiff(serverUrl, filePath, commitHash)
        : [],
    queryFn: () => getFileCommitDiff(filePath!, commitHash!),
    enabled: !!filePath && !!commitHash && options?.enabled !== false,
    staleTime: 5 * 60_000, // Commit diffs are immutable
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch the content of a file at a specific commit.
 */
export function useFileAtCommit(
  filePath: string | null,
  commitHash: string | null,
  options?: { enabled?: boolean },
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<string>({
    queryKey:
      filePath && commitHash
        ? fileHistoryKeys.fileAtCommit(serverUrl, filePath, commitHash)
        : [],
    queryFn: () => getFileAtCommit(filePath!, commitHash!),
    enabled: !!filePath && !!commitHash && options?.enabled !== false,
    staleTime: Infinity, // File content at a commit never changes
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
