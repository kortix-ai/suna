'use client';

import { errorToast } from '@/components/ui/toast';
import { useProjectContext } from '@/features/project-files/context';
import { createProjectSession, markSessionFresh } from '@kortix/sdk';
import { prefetchSessionStart, qk } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  buildChangeRequestRecoveryPrompt,
  recoverySessionName,
  type ChangeRequestRecoveryBlocker,
  type ChangeRequestRecoveryTarget,
} from '../change-request-recovery';

export function useChangeRequestRecovery() {
  const projectId = useProjectContext()?.projectId ?? '';
  const queryClient = useQueryClient();
  const router = useRouter();
  const [startingCrId, setStartingCrId] = useState<string | null>(null);

  const startRecovery = useCallback(
    async (
      target: ChangeRequestRecoveryTarget,
      blocker: ChangeRequestRecoveryBlocker,
      onNavigate?: () => void,
    ) => {
      if (!projectId || startingCrId) return;

      setStartingCrId(target.crId);
      const sessionId = crypto.randomUUID();
      const href = `/projects/${projectId}/sessions/${sessionId}`;
      markSessionFresh(sessionId);
      router.prefetch(href);

      try {
        await createProjectSession(projectId, {
          session_id: sessionId,
          initial_prompt: buildChangeRequestRecoveryPrompt(target, blocker),
          base_ref: target.headRef,
          name: recoverySessionName(target, blocker),
          metadata: {
            kind: 'change-request-recovery',
            change_request_id: target.crId,
            change_request_number: target.number,
            blocker: blocker.kind,
          },
        });
        prefetchSessionStart(queryClient, projectId, sessionId);
        queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
        onNavigate?.();
        router.push(href);
      } catch (error) {
        errorToast(error instanceof Error ? error.message : 'Failed to start recovery session');
      } finally {
        setStartingCrId(null);
      }
    },
    [projectId, queryClient, router, startingCrId],
  );

  return { startRecovery, startingCrId };
}
