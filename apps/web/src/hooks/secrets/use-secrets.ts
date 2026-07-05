'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { deleteEnv, listEnv, setEnv } from '@kortix/sdk/opencode-client';
import { useServerStore } from '@/stores/server-store';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const secretsKeys = {
  all: (instanceUrl: string | null) => ['secrets', instanceUrl ?? 'no-instance'] as const,
};

/**
 * Fetch all secrets (key → full value) via GET /env.
 * The frontend handles masking in the UI.
 */
export function useSecrets() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const instanceUrl = useServerStore((s) => s.getActiveServerUrl());
  const queryKey = secretsKeys.all(instanceUrl || null);

  return useQuery({
    queryKey,
    queryFn: async (): Promise<Record<string, string>> => {
      if (!instanceUrl) return {};
      return listEnv(instanceUrl);
    },
    enabled: !isAuthLoading && !!user && !!instanceUrl,
  });
}

/**
 * Set a single secret via PUT /env/:key.
 */
export function useSetSecret() {
  const qc = useQueryClient();
  const instanceUrl = useServerStore((s) => s.getActiveServerUrl());
  const queryKey = secretsKeys.all(instanceUrl || null);

  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      if (!instanceUrl) throw new Error('No active instance selected');
      await setEnv(instanceUrl, key, value);
    },
    onMutate: async ({ key, value }) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<Record<string, string>>(queryKey);
      if (prev) {
        qc.setQueryData(queryKey, { ...prev, [key]: value });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
    },
  });
}

/**
 * Delete a single secret via DELETE /env/:key.
 */
export function useDeleteSecret() {
  const qc = useQueryClient();
  const instanceUrl = useServerStore((s) => s.getActiveServerUrl());
  const queryKey = secretsKeys.all(instanceUrl || null);

  return useMutation({
    mutationFn: async (key: string) => {
      if (!instanceUrl) throw new Error('No active instance selected');
      await deleteEnv(instanceUrl, key);
    },
    onMutate: async (key) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<Record<string, string>>(queryKey);
      if (prev) {
        const next = { ...prev };
        if (key in next) next[key] = '';
        qc.setQueryData(queryKey, next);
      }
      return { prev };
    },
    onError: (_err, _key, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['secrets'] });
    },
  });
}
