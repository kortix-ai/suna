'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../core/runtime/client';
import type { Config } from '../core/runtime/runtime-types';
import { useRuntimeReady } from './use-runtime-sessions/keys';
import { useRuntimeSupports } from './use-runtime-supports';

export type { Config };

/** @deprecated OpenCode only: pi does not serve it; a daemon built before 2026-10-30 still can. Removed in the next major. */
export const configKeys = {
  all: ['runtime', 'config'] as const,
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
 * @deprecated OpenCode only: pi does not serve it; a daemon built before 2026-10-30 still can. Removed in the next major.
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

