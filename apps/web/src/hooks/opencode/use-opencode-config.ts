'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '@/lib/opencode-sdk';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import type { Config } from '@opencode-ai/sdk/v2/client';

export type { Config };

const configKeys = {
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
  const runtimeReady = useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);
  return useQuery<Config>({
    queryKey: configKeys.all,
    queryFn: async () => {
      const client = getClient();
      const result = await client.global.config.get();
      return unwrap(result);
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
