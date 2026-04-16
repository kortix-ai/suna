'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '@/lib/opencode-sdk';
import type { Config } from '@opencode-ai/sdk/v2/client';

export type { Config };

export const configKeys = {
  all: ['opencode', 'config'] as const,
};

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    const err = result.error as any;
    throw new Error(err?.data?.message || err?.message || 'Request failed');
  }
  return result.data as T;
}

export function useOpenCodeConfig() {
  return useQuery<Config>({
    queryKey: configKeys.all,
    queryFn: async () => {
      const client = getClient();
      const result = await client.global.config.get();
      return unwrap(result);
    },
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useUpdateOpenCodeConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: Partial<Config>) => {
      const client = getClient();
      const result = await client.global.config.update({ config } as any);
      return unwrap(result) as Config;
    },
    onMutate: async (config) => {
      // Cancel in-flight refetches so they don't overwrite optimistic update
      await queryClient.cancelQueries({ queryKey: configKeys.all });
      const previous = queryClient.getQueryData<Config>(configKeys.all);
      if (previous) {
        // Optimistically merge the draft into the cached config
        queryClient.setQueryData<Config>(configKeys.all, {
          ...previous,
          ...config,
          permission: typeof config.permission !== 'undefined'
            ? config.permission
            : previous.permission,
        } as Config);
      }
      return { previous };
    },
    onError: (_err, _config, context) => {
      // Roll back to previous cache on failure
      if (context?.previous) {
        queryClient.setQueryData(configKeys.all, context.previous);
      }
    },
    onSettled: () => {
      // Refetch to get the authoritative server state — only if mounted
      queryClient.refetchQueries({ queryKey: configKeys.all, type: 'active' });
    },
  });
}

/**
 * @deprecated No longer needed — server persists config correctly.
 * Kept as no-op for existing call sites.
 */
export function clearConfigOverrides(): void {
  // no-op — localStorage overrides removed
}
