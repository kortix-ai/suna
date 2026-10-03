'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

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
  wireToModelKey,
} from './use-model-store';
import { resolveModelDefault } from '../core/models/composer-model';
import { qk } from './query-keys';

// Framework-free since it moved to core; re-exported so `./react` keeps it.
export { resolveModelDefault };
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
  agentDefaults: Record<string, ModelKey>;
  projectDefault: ModelKey | undefined;
  platformDefault: ModelKey | undefined;
  freeTier: boolean;
  resolveDefaultFor: (agentName: string | undefined) => ModelKey | undefined;
  setAgentDefault: (agentName: string, model: ModelKey) => Promise<void>;
  setProjectDefault: (model: ModelKey) => Promise<void>;
  clearAgentDefault: (agentName: string) => Promise<void>;
  clearProjectDefault: () => Promise<void>;
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

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: ['gateway-routing-policy', projectId] }),
      // Same entry `useProjectModels`/`useModelEnablement` read.
      queryClient.invalidateQueries({ queryKey: qk.project.modelPicker(projectId ?? '') }),
      queryClient.invalidateQueries({ queryKey: qk.project.modelAccess(projectId ?? '') }),
      queryClient.invalidateQueries({ queryKey: ['project-providers', projectId] }),
    ]);
  }, [projectId, queryClient, queryKey]);

  const setMutation = useMutation({
    mutationFn: (input: {
      scope: 'agent' | 'project';
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
      scope: 'agent' | 'project';
      agentName?: string;
    }) => clearModelDefault(projectId as string, params),
    onSuccess: invalidate,
  });

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
    agentDefaults,
    projectDefault,
    platformDefault,
    // Fail closed while the account policy loads. This prevents a free account
    // from seeing managed models for one render before the server response.
    freeTier: data ? data.freeTier : true,
    resolveDefaultFor,
    setAgentDefault,
    setProjectDefault,
    clearAgentDefault,
    clearProjectDefault,
  };
}
