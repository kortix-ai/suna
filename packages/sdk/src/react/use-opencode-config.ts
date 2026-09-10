'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClientForUrl } from '../core/runtime/client';
import type { Config } from '@opencode-ai/sdk/v2/client';
import { useOpenCodeRuntimeReady } from './use-opencode-sessions/keys';
import { useCurrentRuntime } from './use-current-runtime';

export type { Config };

export const configKeys = {
  all: ['opencode', 'config'] as const,
};

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    // `error`'s shape varies per endpoint's typed error union — duck-type
    // defensively via `unknown` rather than assume a shape.
    const err = result.error;
    const errRec = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
    const dataRec =
      errRec?.data && typeof errRec.data === 'object' ? (errRec.data as Record<string, unknown>) : undefined;
    const message = dataRec?.message ?? errRec?.message;
    throw new Error(typeof message === 'string' ? message : 'Request failed');
  }
  return result.data as T;
}

export function useOpenCodeConfig() {
  const runtimeReady = useOpenCodeRuntimeReady();
  const runtimeUrl = useCurrentRuntime(state => state.url);
  return useQuery<Config>({
    queryKey: [...configKeys.all, runtimeUrl],
    queryFn: async () => {
      if (!runtimeUrl) throw new Error('Session runtime is not ready');
      const client = getClientForUrl(runtimeUrl);
      const result = await client.global.config.get();
      return unwrap(result);
    },
    enabled: runtimeReady && !!runtimeUrl,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useUpdateOpenCodeConfig() {
  const queryClient = useQueryClient();
  const runtimeUrl = useCurrentRuntime(state => state.url);
  const queryKey = [...configKeys.all, runtimeUrl];

  return useMutation({
    mutationFn: async (config: Partial<Config>) => {
      if (!runtimeUrl) throw new Error('Session runtime is not ready');
      const client = getClientForUrl(runtimeUrl);
      // The SDK's `update` param type wants a full `Config`, but the server
      // accepts (and this hook always sends) a partial merge patch.
      const result = await client.global.config.update({ config: config as Config });
      return unwrap(result) as Config;
    },
    onMutate: async (config) => {
      // Cancel in-flight refetches so they don't overwrite optimistic update
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Config>(queryKey);
      if (previous) {
        // Optimistically merge the draft into the cached config
        queryClient.setQueryData<Config>(queryKey, {
          ...previous,
          ...config,
          permission: typeof config.permission !== 'undefined'
            ? config.permission
            : previous.permission,
        } as Config);
      }
      return { previous, queryKey };
    },
    onError: (_err, _config, context) => {
      // Roll back to previous cache on failure
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
    onSettled: (_data, _error, _variables, context) => {
      // Refetch to get the authoritative server state — only if mounted
      if (context) queryClient.refetchQueries({ queryKey: context.queryKey, type: 'active' });
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
