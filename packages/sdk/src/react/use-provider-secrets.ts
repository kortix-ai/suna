'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listAccountSecretResources, listSessionProviderSecretPools, refreshAccountSecretUsage, setSessionProviderSecretPool,
  listSubscriptionConnections, refreshSubscriptionConnectionUsage, type SubscriptionConnection,
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

/** Includes existing subscription logins without moving or reconnecting credentials. */
export function useSubscriptionConnections(accountId: string | null | undefined, projectId: string) {
  return useQuery({
    queryKey: ['account-secret-resources', accountId, projectId, 'subscriptions'],
    queryFn: () => listSubscriptionConnections(accountId!, projectId),
    enabled: Boolean(accountId && projectId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 60_000,
  });
}

/**
 * The live plan usage of one ChatGPT or Claude login while it is on screen:
 * asked once on mount and every minute after. The server reads the provider at
 * most once a minute per login, however many viewers ask.
 */
export function useSubscriptionUsage(accountId: string | null | undefined, secretId: string | null | undefined, options: { enabled?: boolean; projectId?: string; storage?: SubscriptionConnection['storage'] } = {}) {
  return useQuery({
    queryKey: ['subscription-usage', accountId, secretId, options.projectId, options.storage],
    queryFn: () => options.storage && options.projectId
      ? refreshSubscriptionConnectionUsage(accountId!, secretId!, options.projectId, options.storage)
      : refreshAccountSecretUsage(accountId!, secretId!, options.projectId),
    enabled: Boolean(accountId && secretId) && options.enabled !== false,
    staleTime: 30_000,
    refetchInterval: 60_000,
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
