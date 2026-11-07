'use client';

import { useTranslations } from '@/i18n/use-translations';
import { createProjectGoal, generateSessionId } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useUiViewerId } from '@kortix/ui';
import { successToast } from '@kortix/ui/toast';
import { goalHref } from '@kortix/ui/workspace';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';

/**
 * Starts a goal for the viewer (`createProjectGoal` → `POST /goals`: the API
 * sets up GOAL.md in their own folder, the owner session and its heartbeat),
 * then opens the goal's page. One `goal_id` per goal being created: a retry
 * after a failure sends the same id, and the API returns the same goal, so a
 * retry never makes a second one. `reset` takes a new id.
 */
export function useStartGoal(projectId: string, onStarted?: () => void) {
  const t = useTranslations('goals');
  const router = useRouter();
  const queryClient = useQueryClient();
  const viewerId = useUiViewerId();
  const goalId = useRef(generateSessionId());
  const start = useMutation({
    mutationFn: (input: { outcome: string; criteria?: string[]; agent?: string }) =>
      createProjectGoal(projectId, {
        outcome: input.outcome,
        criteria: input.criteria ?? [],
        // The composer's agent owns the goal; unset, the API picks the project's default.
        agent: input.agent ?? null,
        assignedUser: viewerId ?? null,
        goalId: goalId.current,
      }),
    onSuccess: async (created) => {
      // The goal page opens on the goal the API returned: no flash of "not found".
      queryClient.setQueryData(qk.project.goal(projectId, created.goalId), created.goal);
      await queryClient.invalidateQueries({ queryKey: qk.project.goals(projectId), exact: true });
      goalId.current = generateSessionId();
      onStarted?.();
      const href = goalHref(projectId, created);
      if (href) router.push(href);
      successToast(t('startedToast'));
    },
  });
  const reset = () => {
    goalId.current = generateSessionId();
    start.reset();
  };
  return { start, reset };
}
