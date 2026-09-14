'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setProjectSessionModel } from '../core/rest/projects-client';
import { useCurrentRuntime } from './use-current-runtime';
import { configKeys } from './use-opencode-config';
import { qk } from './query-keys';

interface ModelChangeInput {
  model: string;
  projectId: string | undefined;
  sessionId: string | undefined;
  runtimeUrl: string | null;
}

export function useSessionModelChange(projectId: string | undefined, sessionId: string | undefined) {
  const queryClient = useQueryClient();
  const runtimeUrl = useCurrentRuntime(state => state.url);
  const mutation = useMutation({
    mutationFn: async (input: ModelChangeInput) => {
      if (!input.projectId || !input.sessionId) throw new Error('Session identity is required');
      return setProjectSessionModel(input.projectId, input.sessionId, input.model);
    },
    onSuccess: async (_result, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.project.session(input.projectId!, input.sessionId!) }),
        queryClient.invalidateQueries({ queryKey: [...configKeys.all, input.runtimeUrl] }),
      ]);
    },
  });
  return {
    isPending: mutation.isPending,
    mutateAsync: (model: string) => mutation.mutateAsync({ model, projectId, sessionId, runtimeUrl }),
  };
}
