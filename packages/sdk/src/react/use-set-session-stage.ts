'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type SetSessionStageInput,
  setProjectSessionStage,
} from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';

/**
 * Move a session on the Monitoring board. Invalidates the whole sessions
 * family (`sessionsScope`) — both list scopes and the detail read carry
 * `stage`, so one board move must refresh the sidebar, the sessions page and
 * the board together.
 */
export function useSetSessionStage(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, ...input }: SetSessionStageInput & { sessionId: string }) =>
      setProjectSessionStage(projectId, sessionId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) }),
  });
}
