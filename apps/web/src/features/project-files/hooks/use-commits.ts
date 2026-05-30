'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchCommit, fetchCommitDiff, fetchCommits } from '../api/commits';
import { useProjectContext } from '../context';
import type {
  ProjectCommitDetail,
  ProjectCommitDiffResponse,
  ProjectCommitsResponse,
} from '@/lib/projects-client';

export const commitKeys = {
  all: ['project-files', 'commits'] as const,
  list: (projectId: string, ref: string, limit: number, skip: number) =>
    ['project-files', 'commits', projectId, ref, limit, skip] as const,
  detail: (projectId: string, sha: string) =>
    ['project-files', 'commits', projectId, sha] as const,
  diff: (projectId: string, sha: string, path?: string | null) =>
    ['project-files', 'commits', projectId, sha, 'diff', path ?? ''] as const,
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
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = options?.ref ?? ctx?.ref ?? '';
  const limit = options?.limit ?? 50;
  const skip = options?.skip ?? 0;

  return useQuery<ProjectCommitsResponse>({
    queryKey: commitKeys.list(projectId, ref, limit, skip),
    queryFn: () => fetchCommits(projectId, { ref, limit, skip }),
    enabled: Boolean(projectId && ref) && options?.enabled !== false,
    staleTime: 30_000,
  });
}

/** Single checkpoint detail (file list, parents, metadata). */
export function useCommit(sha: string | null, options?: { enabled?: boolean }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';

  return useQuery<ProjectCommitDetail>({
    queryKey: sha ? commitKeys.detail(projectId, sha) : ['project-files', 'commits', 'idle'],
    queryFn: () => fetchCommit(projectId, sha as string),
    enabled: Boolean(projectId && sha) && options?.enabled !== false,
    staleTime: 5 * 60_000,
  });
}

/** Patch for an entire checkpoint, or scoped to a single file path. */
export function useCommitDiff(
  sha: string | null,
  options?: { path?: string | null; enabled?: boolean },
) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';

  return useQuery<ProjectCommitDiffResponse>({
    queryKey: sha
      ? commitKeys.diff(projectId, sha, options?.path)
      : ['project-files', 'commits', 'diff', 'idle'],
    queryFn: () =>
      fetchCommitDiff(projectId, sha as string, {
        path: options?.path ?? undefined,
      }),
    enabled: Boolean(projectId && sha) && options?.enabled !== false,
    staleTime: 5 * 60_000,
  });
}
