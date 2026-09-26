'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listAccountSecretResources, listSessionProviderSecretPools, setSessionProviderSecretPool,
} from '../core/rest/projects-client/account-secret-resources';

export function useAccountSecretResources(accountId: string | null | undefined, projectId?: string) {
  return useQuery({
    queryKey: ['account-secret-resources', accountId, projectId],
    queryFn: () => listAccountSecretResources(accountId!, projectId),
    enabled: Boolean(accountId),
    refetchInterval: (query) => {
      const now = Date.now();
      const deadlines = (query.state.data?.secrets ?? []).map((secret) => Date.parse(secret.cooldown_until ?? '')).filter((deadline) => deadline > now);
      return deadlines.length ? Math.max(1000, Math.min(...deadlines) - now) : false;
    },
  });
}

export function useSessionProviderSecretPools(projectId: string | null | undefined, sessionId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['session-provider-secret-pools', projectId, sessionId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => listSessionProviderSecretPools(projectId!, sessionId!),
    enabled: Boolean(projectId && sessionId),
  });
  const setPool = useMutation({
    mutationFn: ({ providerId, secretIds }: { providerId: string; secretIds: string[] | null }) => {
      if (!projectId || !sessionId) throw new Error('A project and session are required to select provider secrets');
      return setSessionProviderSecretPool(projectId, sessionId, providerId, secretIds);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ['session-provider-secret-pool', projectId, sessionId] }),
      ]);
    },
  });
  return { ...query, setPool };
}
