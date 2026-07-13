'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { Config } from '../core/runtime/wire-types';
import { useRuntimeReady } from './use-runtime-sessions/keys';

export type { Config };

export const configKeys = { all: ['runtime', 'config'] as const };

/**
 * Compatibility projection for consumers that still accept a config object.
 * Kortix configuration is compiled from `kortix.yaml`; ACP does not expose a
 * harness-global mutable config document.
 */
export function useRuntimeConfig() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Config>({
    queryKey: configKeys.all,
    queryFn: async () => ({}),
    enabled: runtimeReady,
    staleTime: Infinity,
  });
}

export function useUpdateRuntimeConfig() {
  return useMutation({
    mutationFn: async (_config: Partial<Config>) => {
      throw new Error('Runtime configuration is declarative; update kortix.yaml through project Customize.');
    },
  });
}

export function clearConfigOverrides(): void {}
