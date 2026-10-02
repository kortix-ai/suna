'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../core/runtime/client';
import type { Config } from '../core/runtime/runtime-types';
import { useRuntimeReady } from './use-opencode-sessions/keys';
import { useRuntimeSupports } from './use-runtime-supports';

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

/**
 * The runtime's own config document (`/global/config`). Only a runtime that
 * serves `session.config` (OpenCode) has one; on any other the query stays
 * off and `data` is undefined. Agents and models come from the project
 * (`/detail`, `/model-picker`), not from here.
 */
export function useRuntimeConfig() {
  const runtimeReady = useRuntimeReady();
  const supported = useRuntimeSupports('session.config');
  return useQuery<Config>({
    queryKey: configKeys.all,
    queryFn: async () => {
      const client = getClient();
      const result = await client.global.config.get();
      return unwrap(result);
    },
    enabled: runtimeReady && supported,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useUpdateRuntimeConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: Partial<Config>) => {
      const client = getClient();
      // The SDK's `update` param type wants a full `Config`, but the server
      // accepts (and this hook always sends) a partial merge patch.
      const result = await client.global.config.update({ config: config as Config });
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

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `useRuntimeConfig`. Removed in the next major. */
export const useOpenCodeConfig = useRuntimeConfig;
/** @deprecated Renamed to `useUpdateRuntimeConfig`. Removed in the next major. */
export const useUpdateOpenCodeConfig = useUpdateRuntimeConfig;
