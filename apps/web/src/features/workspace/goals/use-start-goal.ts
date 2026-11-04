'use client';

import { successToast } from '@kortix/ui/toast';
import { useUiViewerId } from '@kortix/ui';
import { goalHref } from '@kortix/ui/workspace';
import { createProjectGoal, generateSessionId } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { useTranslations } from '@/i18n/use-translations';

/**
 * Starts a goal for the viewer (`createProjectGoal`: GOAL.md in their own
 * folder, its owner session and its heartbeat), then opens the goal's page.
 * One owner session id per goal being created: a retry after a failure reuses
 * it, so a retry never makes a second goal. `reset` takes a new id.
 */
export function useStartGoal(projectId: string, onStarted?: () => void) {
  const t = useTranslations('goals');
  const router = useRouter();
  const queryClient = useQueryClient();
  const viewerId = useUiViewerId();
  const sessionId = useRef(generateSessionId());
  const start = useMutation({
    mutationFn: (input: { outcome: string; criteria?: string[] }) =>
      createProjectGoal(projectId, {
        outcome: input.outcome,
        criteria: input.criteria ?? [],
        assignedUser: viewerId ?? null,
        sessionId: sessionId.current,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: qk.project.goals(projectId) });
      successToast(t('startedToast'));
      sessionId.current = generateSessionId();
      onStarted?.();
      const href = goalHref(projectId, created);
      if (href) router.push(href);
    },
  });
  const reset = () => {
    sessionId.current = generateSessionId();
    start.reset();
  };
  return { start, reset };
}
