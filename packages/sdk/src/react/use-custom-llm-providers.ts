'use client';

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteCustomLlmProvider,
  listCustomLlmProviders,
  putCustomLlmProvider,
  type CustomLlmProvider,
  type CustomLlmProviderInput,
} from '../core/rest/projects-client/custom-llm-providers';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const NO_PROVIDERS: CustomLlmProvider[] = [];

/**
 * A project's custom OpenAI-compatible providers. `save` and `remove` refresh
 * this list and both model-picker caches, so a saved endpoint's models appear
 * in the composer without a reload. `remove` also deletes the provider's
 * `CUSTOM_<ID>_API_KEY` secret and refreshes the secrets list.
 */
export function useCustomLlmProviders(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = qk.project.customLlmProviders(projectId ?? '');
  const query = useQuery({
    queryKey,
    queryFn: () => listCustomLlmProviders(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: qk.project.modelPicker(projectId ?? ''), refetchType: 'all' }),
      queryClient.invalidateQueries({ queryKey: ['project-providers', projectId], refetchType: 'all' }),
    ]);
  const pending = useIsMutating({ mutationKey: queryKey });
  const save = useMutation({
    mutationKey: queryKey,
    mutationFn: ({ providerId, input }: { providerId: string; input: CustomLlmProviderInput }) =>
      putCustomLlmProvider(projectId as string, providerId, input),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationKey: queryKey,
    mutationFn: (providerId: string) => deleteCustomLlmProvider(projectId as string, providerId),
    // The delete also removes the provider's key secret.
    onSuccess: () =>
      Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId ?? '') })]),
  });
  return {
    providers: query.data ?? NO_PROVIDERS,
    // `isLoading`, not `isPending`: a disabled query (no project) never settles `isPending`.
    isLoading: query.isLoading,
    error: query.error,
    save: (providerId: string, input: CustomLlmProviderInput) => save.mutateAsync({ providerId, input }),
    remove: (providerId: string) => remove.mutateAsync(providerId),
    isSaving: pending > 0,
  };
}
