'use client';

import { uiRoutes } from '../../../lib/routes';
import { errorToast } from '../../../primitives/toast';
import { useProjectContext } from '../context';
import { recoverChangeRequest } from '@kortix/sdk';
import { prefetchSessionStart, qk } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '../../../i18n';
import { useUiRouter } from '../../../providers/ui-provider';
import { useCallback, useState } from 'react';
import {
  type ChangeRequestRecoveryBlocker,
  type ChangeRequestRecoveryTarget,
} from '../change-request-recovery';

export function useChangeRequestRecovery() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const projectId = useProjectContext()?.projectId ?? '';
  const queryClient = useQueryClient();
  const router = useUiRouter();
  const [startingCrId, setStartingCrId] = useState<string | null>(null);

  const startRecovery = useCallback(
    async (
      target: ChangeRequestRecoveryTarget,
      blocker: ChangeRequestRecoveryBlocker,
      onNavigate?: () => void,
    ) => {
      if (!projectId || startingCrId) return;

      setStartingCrId(target.crId);
      try {
        const sessionId = await recoverChangeRequest(projectId, target, blocker);
        const href = uiRoutes().session(projectId, sessionId);
        prefetchSessionStart(queryClient, projectId, sessionId);
        queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
        onNavigate?.();
        router.push(href);
      } catch (error) {
        errorToast(error instanceof Error ? error.message : tI18nComplete.raw('text1c8a00d1f262'));
      } finally {
        setStartingCrId(null);
      }
    },
    [projectId, queryClient, router, startingCrId, tI18nComplete],
  );

  return { startRecovery, startingCrId };
}
