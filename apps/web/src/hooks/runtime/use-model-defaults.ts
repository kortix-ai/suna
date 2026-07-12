'use client';

/**
 * Account-scoped default model preferences, server-backed.
 *
 * The LLM gateway is the source of truth for the default model: a request for
 * the synthetic `auto` resolves server-side to the per-agent default → account
 * default → platform default. This hook reads those defaults (for picker
 * display) and writes them (account-level and per-agent), replacing the old
 * localStorage `globalDefault` authority and the per-sandbox
 * `/kortix/preferences/model` round-trip.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clearModelDefault,
  getModelDefaults,
  type ModelDefaultsResponse,
  setModelDefault,
} from '@kortix/sdk/projects-client';
import {
  type ModelKey,
  modelKeyToWire,
  seedGlobalDefaultFromServer,
  setGlobalDefaultModel,
  wireToModelKey,
} from './use-model-store';

export interface UseModelDefaults {
  data: ModelDefaultsResponse | undefined;
  isLoading: boolean;
  accountDefault: ModelKey | undefined;
  agentDefaults: Record<string, ModelKey>;
  projectDefault: ModelKey | undefined;
  platformDefault: ModelKey | undefined;
  freeTier: boolean;
  /** The configured default for an agent: agent → project → account → platform. */
  resolveDefaultFor: (agentName: string | undefined) => ModelKey | undefined;
  setAccountDefault: (model: ModelKey) => Promise<void>;
  setAgentDefault: (agentName: string, model: ModelKey) => Promise<void>;
  setProjectDefault: (model: ModelKey) => Promise<void>;
  clearAccountDefault: () => Promise<void>;
  clearAgentDefault: (agentName: string) => Promise<void>;
  clearProjectDefault: () => Promise<void>;
}

export function useModelDefaults(projectId: string | null | undefined): UseModelDefaults {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['model-defaults', projectId], [projectId]);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getModelDefaults(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });

  // Seed the local globalDefault cache from the server so display paths that
  // still read it (and offline/first-paint) reflect the account default.
  useEffect(() => {
    if (!data) return;
    // Passive seed — must NOT clear the user's explicit per-agent/per-session picks.
    seedGlobalDefaultFromServer(
      data.accountDefault ? wireToModelKey(data.accountDefault) : undefined,
    );
  }, [data?.accountDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const setMutation = useMutation({
    mutationFn: (input: { scope: 'account' | 'agent' | 'project'; agentName?: string; model: string }) =>
      setModelDefault(projectId as string, input),
    onSuccess: invalidate,
  });
  const clearMutation = useMutation({
    mutationFn: (params: { scope: 'account' | 'agent' | 'project'; agentName?: string }) =>
      clearModelDefault(projectId as string, params),
    onSuccess: invalidate,
  });

  const accountDefault = useMemo<ModelKey | undefined>(
    () => (data?.accountDefault ? wireToModelKey(data.accountDefault) : undefined),
    [data?.accountDefault],
  );
  const agentDefaults = useMemo<Record<string, ModelKey>>(() => {
    const out: Record<string, ModelKey> = {};
    for (const [name, wire] of Object.entries(data?.agentDefaults ?? {})) {
      out[name] = wireToModelKey(wire);
    }
    return out;
  }, [data?.agentDefaults]);
  const projectDefault = useMemo<ModelKey | undefined>(
    () => (data?.projectDefault ? wireToModelKey(data.projectDefault) : undefined),
    [data?.projectDefault],
  );
  const platformDefault = useMemo<ModelKey | undefined>(
    () => (data?.platformDefault ? wireToModelKey(data.platformDefault) : undefined),
    [data?.platformDefault],
  );

  const resolveDefaultFor = useCallback(
    (agentName: string | undefined): ModelKey | undefined => {
      const wire =
        (agentName ? data?.agentDefaults?.[agentName] : undefined) ??
        data?.projectDefault ??
        data?.accountDefault ??
        data?.platformDefault;
      return wire ? wireToModelKey(wire) : undefined;
    },
    [data?.agentDefaults, data?.projectDefault, data?.accountDefault, data?.platformDefault],
  );

  const setAccountDefault = useCallback(
    async (model: ModelKey) => {
      setGlobalDefaultModel(model); // optimistic local cache
      await setMutation.mutateAsync({ scope: 'account', model: modelKeyToWire(model) });
    },
    [setMutation],
  );
  const setAgentDefault = useCallback(
    async (agentName: string, model: ModelKey) => {
      await setMutation.mutateAsync({ scope: 'agent', agentName, model: modelKeyToWire(model) });
    },
    [setMutation],
  );
  const setProjectDefault = useCallback(
    async (model: ModelKey) => {
      await setMutation.mutateAsync({ scope: 'project', model: modelKeyToWire(model) });
    },
    [setMutation],
  );
  const clearAccountDefault = useCallback(async () => {
    setGlobalDefaultModel(undefined);
    await clearMutation.mutateAsync({ scope: 'account' });
  }, [clearMutation]);
  const clearAgentDefault = useCallback(
    async (agentName: string) => {
      await clearMutation.mutateAsync({ scope: 'agent', agentName });
    },
    [clearMutation],
  );
  const clearProjectDefault = useCallback(async () => {
    await clearMutation.mutateAsync({ scope: 'project' });
  }, [clearMutation]);

  return {
    data,
    isLoading,
    accountDefault,
    agentDefaults,
    projectDefault,
    platformDefault,
    freeTier: !!data?.freeTier,
    resolveDefaultFor,
    setAccountDefault,
    setAgentDefault,
    setProjectDefault,
    clearAccountDefault,
    clearAgentDefault,
    clearProjectDefault,
  };
}
