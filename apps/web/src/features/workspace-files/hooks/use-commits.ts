'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchCommit, fetchCommitDiff, fetchCommits } from '../api/commits';
import { useWorkspaceContext } from '../context';
import type {
  WorkspaceCommitDetail,
  WorkspaceCommitDiffResponse,
  WorkspaceCommitsResponse,
} from '@kortix/sdk';

export const commitKeys = {
  all: ['workspace-files', 'commits'] as const,
  /** Project-scoped, ref-agnostic prefix — reaches `list` AND `detail`/`diff`
   *  (both nest further under it) for one project. Used for "a commit landed
   *  on this workspace, refresh everything commit-related" invalidation. */
  workspace: (workspaceId: string) => ['workspace-files', 'commits', workspaceId] as const,
  list: (workspaceId: string, ref: string, limit: number, skip: number) =>
    ['workspace-files', 'commits', workspaceId, ref, limit, skip] as const,
  detail: (workspaceId: string, sha: string) =>
    ['workspace-files', 'commits', workspaceId, sha] as const,
  diff: (workspaceId: string, sha: string, path?: string | null) =>
    ['workspace-files', 'commits', workspaceId, sha, 'diff', path ?? ''] as const,
};

/**
 * Full-repo checkpoint (commit) history for the active version (ref). Newest
 * first. `hasMore` indicates whether further pages exist beyond `limit+skip`.
 */
export function useCommits(options?: {
  ref?: string;
  limit?: number;
  skip?: number;
  enabled?: boolean;
}) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';
  const ref = options?.ref ?? ctx?.ref ?? '';
  const limit = options?.limit ?? 50;
  const skip = options?.skip ?? 0;

  return useQuery<WorkspaceCommitsResponse>({
    queryKey: commitKeys.list(workspaceId, ref, limit, skip),
    queryFn: () => fetchCommits(workspaceId, { ref, limit, skip }),
    enabled: Boolean(workspaceId && ref) && options?.enabled !== false,
    staleTime: 30_000,
  });
}

/** Single checkpoint detail (file list, parents, metadata). */
export function useCommit(sha: string | null, options?: { enabled?: boolean }) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';

  return useQuery<WorkspaceCommitDetail>({
    queryKey: sha ? commitKeys.detail(workspaceId, sha) : ['workspace-files', 'commits', 'idle'],
    queryFn: () => fetchCommit(workspaceId, sha as string),
    enabled: Boolean(workspaceId && sha) && options?.enabled !== false,
    staleTime: 5 * 60_000,
  });
}

/** Patch for an entire checkpoint, or scoped to a single file path. */
export function useCommitDiff(
  sha: string | null,
  options?: { path?: string | null; enabled?: boolean },
) {
  const ctx = useWorkspaceContext();
  const workspaceId = ctx?.workspaceId ?? '';

  return useQuery<WorkspaceCommitDiffResponse>({
    queryKey: sha
      ? commitKeys.diff(workspaceId, sha, options?.path)
      : ['workspace-files', 'commits', 'diff', 'idle'],
    queryFn: () =>
      fetchCommitDiff(workspaceId, sha as string, {
        path: options?.path ?? undefined,
      }),
    enabled: Boolean(workspaceId && sha) && options?.enabled !== false,
    staleTime: 5 * 60_000,
  });
}
