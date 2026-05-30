'use client';

/**
 * useProjectOnboarding — server-side per-project guided-onboarding status.
 *
 * Tracks whether the project's guided onboarding wizard has been completed
 * (or explicitly skipped). Persisted server-side in `projects.metadata.
 * onboarding_completed_at` (a single ISO timestamp; presence = completed)
 * via PATCH /v1/projects/:projectId/onboarding. No schema migration needed —
 * the metadata jsonb already exists and serializeProject already exposes it.
 *
 *   status === 'pending'   → first-time, wizard auto-opens
 *   status === 'completed' → user finished or skipped, wizard stays closed
 *
 * Reads ride on the same `project-detail` query the rest of the project uses
 * so there's no extra round-trip — completion just reflects whatever the
 * already-cached metadata says. `complete()` mutates the server AND
 * optimistically updates the cache so the wizard fades out instantly.
 */

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getProjectDetail,
  setProjectOnboardingComplete,
} from '@/lib/projects-client';

export type ProjectOnboardingStatus = 'pending' | 'completed';

/** Shape of the cached `project-detail` query data. */
type ProjectDetailData = Awaited<ReturnType<typeof getProjectDetail>>;

interface ProjectMetadataMaybe {
  onboarding_completed_at?: string | null;
  [key: string]: unknown;
}

export interface ProjectOnboardingState {
  status: ProjectOnboardingStatus;
  /** False until the project-detail query has resolved at least once. */
  hydrated: boolean;
  /** Mark complete (server) + optimistically update local cache. */
  complete: () => Promise<unknown>;
  /** Re-open onboarding by clearing the server flag. Mostly for QA/devtools. */
  reset: () => Promise<unknown>;
}

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function useProjectOnboarding(projectId: string): ProjectOnboardingState {
  const enabled = !!projectId;
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled,
    ...Q,
  });

  const status: ProjectOnboardingStatus = useMemo(() => {
    const meta = (detail.data?.project?.metadata ?? {}) as ProjectMetadataMaybe;
    return meta.onboarding_completed_at ? 'completed' : 'pending';
  }, [detail.data]);

  // Optimistic cache update mirrors what the server will return, so the
  // wizard fades out immediately and we don't refetch before the UI reacts.
  const applyOptimistic = useCallback(
    (completed: boolean) => {
      const key = ['project-detail', projectId] as const;
      queryClient.setQueryData(key, (prev: ProjectDetailData | undefined) => {
        if (!prev?.project) return prev;
        const meta = { ...(prev.project.metadata ?? {}) } as ProjectMetadataMaybe;
        if (completed) {
          meta.onboarding_completed_at = new Date().toISOString();
        } else {
          delete meta.onboarding_completed_at;
        }
        return {
          ...prev,
          project: { ...prev.project, metadata: meta },
        };
      });
    },
    [projectId, queryClient],
  );

  // Snapshot the cache before the optimistic write so onError restores the
  // exact prior value — applying the *opposite* optimistic update would clobber
  // a pre-existing onboarding_completed_at (e.g. an already-completed project).
  const snapshotThenApply = useCallback(
    async (completed: boolean) => {
      const key = ['project-detail', projectId] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProjectDetailData>(key);
      applyOptimistic(completed);
      return { previous };
    },
    [projectId, queryClient, applyOptimistic],
  );

  const restorePrevious = useCallback(
    (context: { previous: ProjectDetailData | undefined } | undefined) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(['project-detail', projectId], context.previous);
      }
    },
    [projectId, queryClient],
  );

  const completeMutation = useMutation({
    mutationFn: () => setProjectOnboardingComplete(projectId, true),
    onMutate: () => snapshotThenApply(true),
    onError: (_err, _vars, context) => restorePrevious(context),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => setProjectOnboardingComplete(projectId, false),
    onMutate: () => snapshotThenApply(false),
    onError: (_err, _vars, context) => restorePrevious(context),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
    },
  });

  return {
    status,
    hydrated: enabled && !detail.isLoading,
    complete: () => completeMutation.mutateAsync(),
    reset: () => resetMutation.mutateAsync(),
  };
}
