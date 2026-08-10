'use client';

import { errorToast } from '@/components/ui/toast';
import { useWorkspaceContext } from '@/features/workspace-files/context';
import { createWorkspaceSession } from '@kortix/sdk';
import { markSessionFresh } from '@kortix/sdk/fresh-sessions';
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
  const workspaceId = useWorkspaceContext()?.workspaceId ?? '';
  const queryClient = useQueryClient();
  const router = useRouter();
  const [startingCrId, setStartingCrId] = useState<string | null>(null);

  const startRecovery = useCallback(
    async (
      target: ChangeRequestRecoveryTarget,
      blocker: ChangeRequestRecoveryBlocker,
      onNavigate?: () => void,
    ) => {
      if (!workspaceId || startingCrId) return;

      setStartingCrId(target.crId);
      const sessionId = crypto.randomUUID();
      const href = `/workspaces/${workspaceId}/sessions/${sessionId}`;
      markSessionFresh(sessionId);
      router.prefetch(href);

      try {
        await createWorkspaceSession(workspaceId, {
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
        prefetchSessionStart(queryClient, workspaceId, sessionId);
        queryClient.invalidateQueries({ queryKey: qk.workspace.sessionsScope(workspaceId) });
        onNavigate?.();
        router.push(href);
      } catch (error) {
        errorToast(error instanceof Error ? error.message : 'Failed to start recovery session');
      } finally {
        setStartingCrId(null);
      }
    },
    [workspaceId, queryClient, router, startingCrId],
  );

  return { startRecovery, startingCrId };
}
