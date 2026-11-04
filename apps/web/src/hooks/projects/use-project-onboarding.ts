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
 * Reads ride on the bare project row (`qk.project.summary(id)`, one database
 * read) the project shell already holds, so there's no extra round-trip and no
 * wait on the git-backed detail — completion just reflects whatever the
 * already-cached metadata says. `complete()` mutates the server AND
 * optimistically updates the cache so the wizard fades out instantly.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { getProject, setProjectOnboardingComplete } from '@kortix/sdk';
import { contract, invalidateProject, qk } from '@kortix/sdk/react';

export type ProjectOnboardingStatus = 'pending' | 'completed';

/** Shape of the cached project-row query data. */
type ProjectRowData = Awaited<ReturnType<typeof getProject>>;

interface ProjectMetadataMaybe {
  onboarding_completed_at?: string | null;
  [key: string]: unknown;
}

export interface ProjectOnboardingState {
  status: ProjectOnboardingStatus;
  /** False until the project-row query has resolved at least once. */
  hydrated: boolean;
  /** Mark complete (server) + optimistically update local cache. */
  complete: () => Promise<unknown>;
  /** Re-open onboarding by clearing the server flag. Mostly for QA/devtools. */
  reset: () => Promise<unknown>;
}

export function useProjectOnboarding(projectId: string): ProjectOnboardingState {
  const enabled = !!projectId;
  const queryClient = useQueryClient();

  const row = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    enabled,
    ...contract('config'),
  });

  const status: ProjectOnboardingStatus = useMemo(() => {
    const meta = (row.data?.metadata ?? {}) as ProjectMetadataMaybe;
    return meta.onboarding_completed_at ? 'completed' : 'pending';
  }, [row.data]);

  // Optimistic cache update mirrors what the server will return, so the
  // wizard fades out immediately and we don't refetch before the UI reacts.
  const applyOptimistic = useCallback(
    (completed: boolean) => {
      const key = qk.project.summary(projectId);
      queryClient.setQueryData(key, (prev: ProjectRowData | undefined) => {
        if (!prev) return prev;
        const meta = { ...(prev.metadata ?? {}) } as ProjectMetadataMaybe;
        if (completed) {
          meta.onboarding_completed_at = new Date().toISOString();
        } else {
          delete meta.onboarding_completed_at;
        }
        return { ...prev, metadata: meta };
      });
    },
    [projectId, queryClient],
  );

  // Snapshot the cache before the optimistic write so onError restores the
  // exact prior value — applying the *opposite* optimistic update would clobber
  // a pre-existing onboarding_completed_at (e.g. an already-completed project).
  const snapshotThenApply = useCallback(
    async (completed: boolean) => {
      const key = qk.project.summary(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProjectRowData>(key);
      applyOptimistic(completed);
      return { previous };
    },
    [projectId, queryClient, applyOptimistic],
  );

  const restorePrevious = useCallback(
    (context: { previous: ProjectRowData | undefined } | undefined) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(qk.project.summary(projectId), context.previous);
      }
    },
    [projectId, queryClient],
  );

  const completeMutation = useMutation({
    mutationFn: () => setProjectOnboardingComplete(projectId, true),
    onMutate: () => snapshotThenApply(true),
    onError: (_err, _vars, context) => restorePrevious(context),
    onSettled: () => {
      void invalidateProject(queryClient, projectId);
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => setProjectOnboardingComplete(projectId, false),
    onMutate: () => snapshotThenApply(false),
    onError: (_err, _vars, context) => restorePrevious(context),
    onSettled: () => {
      void invalidateProject(queryClient, projectId);
    },
  });

  return {
    status,
    hydrated: enabled && !row.isLoading,
    complete: () => completeMutation.mutateAsync(),
    reset: () => resetMutation.mutateAsync(),
  };
}
