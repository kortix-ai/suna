'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { ApiError, MODEL_NOT_SERVABLE_CODE } from '../core/http/api-client';
import { platformConfig } from '../core/http/config';
import {
  clearModelDefault,
  getModelDefaults,
  type ModelDefaultsResponse,
  setModelDefault,
} from '../core/rest/projects-client/model-defaults';
import {
  type ModelKey,
  modelKeyToWire,
  seedGlobalDefaultFromServer,
  setGlobalDefaultModel,
  wireToModelKey,
} from './use-model-store';
import { qk } from './query-keys';
import { useProjectLlmGatewayEnabled } from './use-project-llm-gateway';

export interface UseModelDefaults {
  data: ModelDefaultsResponse | undefined;
  isLoading: boolean;
  isUpdating: boolean;
  /**
   * The project's `llm_gateway` flag. False ⇒ the model-defaults chain does
   * not exist for this project (native OpenCode mode): `data` never loads,
   * and UIs must hide every set/clear affordance — the write routes answer
   * 404 llm_gateway_disabled.
   */
  llmGatewayEnabled: boolean;
  accountDefault: ModelKey | undefined;
  agentDefaults: Record<string, ModelKey>;
  projectDefault: ModelKey | undefined;
  platformDefault: ModelKey | undefined;
  freeTier: boolean;
  resolveDefaultFor: (agentName: string | undefined) => ModelKey | undefined;
  setAccountDefault: (model: ModelKey) => Promise<void>;
  setAgentDefault: (agentName: string, model: ModelKey) => Promise<void>;
  setProjectDefault: (model: ModelKey) => Promise<void>;
  clearAccountDefault: () => Promise<void>;
  clearAgentDefault: (agentName: string) => Promise<void>;
  clearProjectDefault: () => Promise<void>;
}

export function resolveModelDefault(
  data: ModelDefaultsResponse | undefined,
  agentName: string | undefined,
): ModelKey | undefined {
  const wire =
    (agentName ? data?.agentDefaults?.[agentName] : undefined) ??
    data?.projectDefault ??
    data?.accountDefault ??
    (data?.freeTier ? undefined : data?.platformDefault);
  return wire ? wireToModelKey(wire) : undefined;
}

export function useModelDefaults(
  projectId: string | null | undefined,
): UseModelDefaults {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['model-defaults', projectId], [projectId]);

  // The model-defaults chain is a GATEWAY concept: with the project's
  // llm_gateway flag off the route answers 404 llm_gateway_disabled and
  // OpenCode resolves the default model in the sandbox — never fetch.
  const gateway = useProjectLlmGatewayEnabled(projectId);
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getModelDefaults(projectId as string),
    enabled: !!projectId && gateway.enabled,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!data) return;
    seedGlobalDefaultFromServer(
      data.accountDefault ? wireToModelKey(data.accountDefault) : undefined,
    );
  }, [data?.accountDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: ['gateway-routing-policy', projectId] }),
      // Same entry `useProjectModels`/`useModelEnablement` read.
      queryClient.invalidateQueries({ queryKey: qk.project.modelPicker(projectId ?? '') }),
      queryClient.invalidateQueries({ queryKey: ['project-providers', projectId] }),
    ]);
  }, [projectId, queryClient, queryKey]);

  const setMutation = useMutation({
    mutationFn: (input: {
      scope: 'account' | 'agent' | 'project';
      agentName?: string;
      model: string;
    }) => setModelDefault(projectId as string, input),
    onSuccess: invalidate,
    // The model-defaults PUT can reject with a TYPED 409 `model_not_servable`
    // (the user picked a model their account can't use — free-tier managed
    // model, disconnected BYOK provider). That's an EXPECTED UI validation
    // state, not a server defect: `makeRequest` already drops it from Sentry
    // (see `MODEL_NOT_SERVABLE_CODE`), but every call site fires-and-forgets
    // the returned promise (`void setXxxDefault(...)`), so without an
    // `onError` here the rejected `mutateAsync` becomes an UNHANDLED rejection
    // → Sentry's `onunhandledrejection` (Better Stack pattern `ed07f6c5…`).
    // Branch on the typed code and surface a user-facing toast via the
    // platform seam; swallow the rejection so the `void` call sites stay
    // quiet. A non-`model_not_servable` failure still toasts (and is reported
    // to Sentry by `makeRequest`, since it isn't classified silent).
    onError: (error: unknown) => {
      const message =
        error instanceof ApiError && error.code === MODEL_NOT_SERVABLE_CODE
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Could not set the default model';
      try {
        platformConfig().onToast?.('error', message);
      } catch {
        // Never let the toast sink break the error path.
      }
    },
  });
  const clearMutation = useMutation({
    mutationFn: (params: {
      scope: 'account' | 'agent' | 'project';
      agentName?: string;
    }) => clearModelDefault(projectId as string, params),
    onSuccess: invalidate,
  });

  const accountDefault = useMemo(
    () => (data?.accountDefault ? wireToModelKey(data.accountDefault) : undefined),
    [data?.accountDefault],
  );
  const agentDefaults = useMemo<Record<string, ModelKey>>(() => {
    const defaults: Record<string, ModelKey> = {};
    for (const [name, wire] of Object.entries(data?.agentDefaults ?? {})) {
      defaults[name] = wireToModelKey(wire);
    }
    return defaults;
  }, [data?.agentDefaults]);
  const projectDefault = useMemo(
    () => (data?.projectDefault ? wireToModelKey(data.projectDefault) : undefined),
    [data?.projectDefault],
  );
  const platformDefault = useMemo(
    () => (data?.platformDefault ? wireToModelKey(data.platformDefault) : undefined),
    [data?.platformDefault],
  );
  const resolveDefaultFor = useCallback(
    (agentName: string | undefined) => resolveModelDefault(data, agentName),
    [data],
  );

  const setAccountDefault = useCallback(
    async (model: ModelKey) => {
      setGlobalDefaultModel(model);
      await setMutation.mutateAsync({
        scope: 'account',
        model: modelKeyToWire(model),
      });
    },
    [setMutation],
  );
  const setAgentDefault = useCallback(
    async (agentName: string, model: ModelKey) => {
      await setMutation.mutateAsync({
        scope: 'agent',
        agentName,
        model: modelKeyToWire(model),
      });
    },
    [setMutation],
  );
  const setProjectDefault = useCallback(
    async (model: ModelKey) => {
      await setMutation.mutateAsync({
        scope: 'project',
        model: modelKeyToWire(model),
      });
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
    isUpdating: setMutation.isPending || clearMutation.isPending,
    llmGatewayEnabled: gateway.enabled,
    accountDefault,
    agentDefaults,
    projectDefault,
    platformDefault,
    // Fail closed while the account policy loads. This prevents a free account
    // from seeing managed models for one render before the server response.
    freeTier: data ? data.freeTier : true,
    resolveDefaultFor,
    setAccountDefault,
    setAgentDefault,
    setProjectDefault,
    clearAccountDefault,
    clearAgentDefault,
    clearProjectDefault,
  };
}
