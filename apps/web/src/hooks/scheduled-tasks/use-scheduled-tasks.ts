import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '@/lib/auth-token';
import { useAuth } from '@/components/AuthProvider';
import { ensureSandbox, getSandboxUrl } from '@/lib/platform-client';
import { getActiveOpenCodeUrl, getServerByInstanceId, resolveServerUrl } from '@/stores/server-store';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SessionMode = 'new' | 'reuse';
export type TriggerType = 'cron' | 'webhook';
export type ActionType = 'prompt' | 'command' | 'http';
export type TriggerSourceType = 'manual' | 'agent';

export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'skipped';

export interface Trigger {
  id: string;
  triggerId: string | null;
  type: TriggerType;
  sourceType: TriggerSourceType;
  sandboxId?: string;
  accountId?: string;
  name: string;
  description: string | null;
  cronExpr: string | null;
  timezone: string | null;
  agentName: string | null;
  modelProviderId: string | null;
  modelId: string | null;
  prompt: string;
  sessionMode: SessionMode;
  sessionId?: string | null;
  isActive: boolean;
  enabled?: boolean;
  editable: boolean;
  agentFilePath?: string | null;
  maxRetries: number;
  timeoutMs: number;
  metadata: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  webhook: {
    path: string;
    method: string;
    secretProtected: boolean;
  } | null;
  // Unified trigger fields
  source_type?: string;
  source_config?: Record<string, unknown>;
  action_type?: ActionType;
  action_config?: Record<string, unknown>;
  context_config?: Record<string, unknown>;
}

export interface Execution {
  executionId: string;
  triggerId: string;
  sandboxId?: string;
  status: ExecutionStatus;
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
  httpStatus?: number | null;
  retryCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  trigger_name?: string;
}

export interface CreateTriggerData {
  sandbox_id?: string;
  name: string;
  description?: string;
  source: {
    type: TriggerType;
    cron_expr?: string;
    timezone?: string;
    path?: string;
    method?: string;
    secret?: string;
  };
  action: {
    type?: ActionType;
    prompt?: string;
    agent?: string;
    model?: string;
    session_mode?: SessionMode;
    command?: string;
    args?: string[];
    workdir?: string;
    timeout_ms?: number;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body_template?: string;
  };
  context?: {
    extract?: Record<string, string>;
    include_raw?: boolean;
  };
  metadata?: Record<string, unknown>;
  // Legacy compat fields
  cron_expr?: string;
  timezone?: string;
  agent_name?: string;
  model_provider_id?: string;
  model_id?: string;
  prompt?: string;
  session_mode?: SessionMode;
}

export interface UpdateTriggerData {
  name?: string;
  description?: string | null;
  source?: Partial<CreateTriggerData['source']>;
  action?: Partial<CreateTriggerData['action']>;
  context?: CreateTriggerData['context'];
  is_active?: boolean;
  metadata?: Record<string, unknown>;
  // Legacy compat
  cron_expr?: string;
  timezone?: string;
  agent_name?: string | null;
  model_provider_id?: string | null;
  model_id?: string | null;
  prompt?: string;
  session_mode?: SessionMode;
  session_id?: string | null;
  max_retries?: number;
  timeout_ms?: number;
}

// ─── API Functions ──────────────────────────────────────────────────────────

interface ApiListResponse {
  success: boolean;
  data: Trigger[];
  total: number;
}

interface ApiSingleResponse {
  success: boolean;
  data: Trigger;
}

interface ApiExecutionsResponse {
  success: boolean;
  data: Execution[];
  total: number;
  limit: number;
  offset: number;
}

interface ApiRunResponse {
  success: boolean;
  data: {
    execution_id: string;
    status: string;
    message: string;
  };
}

async function resolveSandboxBaseUrl(instanceId?: string | null): Promise<string> {
  if (instanceId) {
    const server = getServerByInstanceId(instanceId);
    if (server) return resolveServerUrl(server).replace(/\/+$/, '');
  }

  const activeBaseUrl = getActiveOpenCodeUrl();
  if (activeBaseUrl) return activeBaseUrl.replace(/\/+$/, '');

  const { sandbox } = await ensureSandbox();
  return getSandboxUrl(sandbox).replace(/\/+$/, '');
}

async function getTriggersBaseUrl(instanceId?: string | null): Promise<string> {
  return `${await resolveSandboxBaseUrl(instanceId)}/kortix/triggers`;
}

async function fetchTriggersJson<T>(path: string, init?: RequestInit, instanceId?: string | null): Promise<T> {
  const baseUrl = await getTriggersBaseUrl(instanceId);
  const response = await authenticatedFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error || body?.message || `Request failed with ${response.status}`);
  }
  return body as T;
}

const fetchTriggers = async (sandboxId?: string): Promise<Trigger[]> => {
  const api = await fetchTriggersJson<ApiListResponse>('', undefined, sandboxId);
  const normalized = api.data.map((trigger) => ({
    ...trigger,
    maxRetries: trigger.maxRetries ?? 0,
    timeoutMs: trigger.timeoutMs ?? 300000,
    metadata: trigger.metadata ?? {},
    isActive: trigger.isActive ?? trigger.enabled ?? true,
  }));
  return normalized;
};

const fetchTrigger = async (triggerId: string): Promise<Trigger> => {
  const response = await fetchTriggersJson<ApiSingleResponse>(`/${triggerId}`);
  return response.data;
};

const createTrigger = async (data: CreateTriggerData): Promise<Trigger> => {
  const { sandbox_id: _sandboxId, ...payload } = data;
  const response = await fetchTriggersJson<ApiSingleResponse>('', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return response.data;
};

const updateTrigger = async ({ id, data }: { id: string; data: UpdateTriggerData }): Promise<Trigger> => {
  const response = await fetchTriggersJson<ApiSingleResponse>(`/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return response.data;
};

const deleteTrigger = async (id: string): Promise<void> => {
  await fetchTriggersJson(`/${id}`, { method: 'DELETE' });
};

const pauseTrigger = async (id: string): Promise<Trigger> => {
  const response = await fetchTriggersJson<ApiSingleResponse>(`/${id}/pause`, { method: 'POST' });
  return response.data;
};

const resumeTrigger = async (id: string): Promise<Trigger> => {
  const response = await fetchTriggersJson<ApiSingleResponse>(`/${id}/resume`, { method: 'POST' });
  return response.data;
};

const runTrigger = async (id: string): Promise<{ execution_id: string; status: string; message: string }> => {
  const response = await fetchTriggersJson<ApiRunResponse>(`/${id}/run`, { method: 'POST' });
  return response.data;
};

const fetchExecutions = async (triggerId: string, limit = 50, offset = 0): Promise<Execution[]> => {
  const response = await fetchTriggersJson<ApiExecutionsResponse>(
    `/executions/by-trigger/${triggerId}?limit=${limit}&offset=${offset}`,
  );
  return response.data;
};

// ─── Hooks ──────────────────────────────────────────────────────────────────

export const useTriggers = (sandboxId?: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  return useQuery({
    queryKey: ['triggers', sandboxId ?? null, user?.id ?? 'anonymous'],
    queryFn: () => fetchTriggers(sandboxId),
    // When sandboxId is absent, backend returns all triggers for the account.
    enabled: !isAuthLoading && !!user,
    staleTime: 1 * 60 * 1000,
    refetchInterval: 30 * 1000,
  });
};

export const useTrigger = (triggerId: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  return useQuery({
    queryKey: ['trigger', triggerId, user?.id ?? 'anonymous'],
    queryFn: () => fetchTrigger(triggerId),
    enabled: !isAuthLoading && !!user && !!triggerId,
    staleTime: 1 * 60 * 1000,
  });
};

export const useCreateTrigger = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTrigger,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triggers'] });
    },
  });
};

export const useUpdateTrigger = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateTrigger,
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['triggers'] });
      queryClient.invalidateQueries({ queryKey: ['trigger', updated.triggerId] });
    },
  });
};

export const useDeleteTrigger = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteTrigger,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triggers'] });
    },
  });
};

export const useToggleTrigger = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return isActive ? resumeTrigger(id) : pauseTrigger(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triggers'] });
    },
  });
};

export const useRunTrigger = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: runTrigger,
    onSuccess: () => {
      // Refresh executions after manual run
      queryClient.invalidateQueries({ queryKey: ['trigger-executions'] });
    },
  });
};

export const useTriggerExecutions = (triggerId: string, limit = 50) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  return useQuery({
    queryKey: ['trigger-executions', triggerId, limit, user?.id ?? 'anonymous'],
    queryFn: () => fetchExecutions(triggerId, limit),
    enabled: !isAuthLoading && !!user && !!triggerId,
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });
};

// ─── Sandbox Models & Agents ────────────────────────────────────────────────

export interface SandboxModel {
  id: string;
  name: string;
}

export interface SandboxProvider {
  id: string;
  name: string;
  models: SandboxModel[];
}

export interface SandboxAgent {
  name: string;
  description?: string;
  mode?: string;
}

async function getSandboxBaseUrl(instanceId?: string | null): Promise<string> {
  return resolveSandboxBaseUrl(instanceId);
}

const fetchSandboxModels = async (sandboxId: string): Promise<SandboxProvider[]> => {
  const baseUrl = await getSandboxBaseUrl(sandboxId);
  const response = await authenticatedFetch(`${baseUrl}/config/providers`);
  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status})`);
  }

  const data = await response.json() as Record<string, unknown> | unknown[];
  const rawProviders: any[] = Array.isArray(data) ? data : ((data.providers || []) as any[]);
  return rawProviders.map((provider: any) => ({
    id: provider.id || '',
    name: provider.name || provider.id || '',
    models: Object.values(provider.models || {}).map((model: any) => ({
      id: model.id || '',
      name: model.name || model.id || '',
    })),
  }));
};

const fetchSandboxAgents = async (sandboxId: string): Promise<SandboxAgent[]> => {
  const baseUrl = await getSandboxBaseUrl(sandboxId);
  const response = await authenticatedFetch(`${baseUrl}/agent`);
  if (!response.ok) {
    throw new Error(`Failed to fetch agents (${response.status})`);
  }

  const data = await response.json() as Record<string, unknown> | unknown[];
  const rawAgents: any[] = Array.isArray(data) ? data : ((data.agents || Object.values(data)) as any[]);
  return rawAgents.map((agent: any) => ({
    name: agent.name || '',
    description: agent.description,
    mode: agent.mode,
  }));
};

export const useSandboxModels = (sandboxId?: string | null) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  return useQuery({
    queryKey: ['sandbox-models', sandboxId, user?.id ?? 'anonymous'],
    queryFn: () => fetchSandboxModels(sandboxId!),
    enabled: !isAuthLoading && !!user && !!sandboxId,
    staleTime: 5 * 60 * 1000, // 5 min cache — models don't change often
  });
};

export const useSandboxAgents = (sandboxId?: string | null) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  return useQuery({
    queryKey: ['sandbox-agents', sandboxId, user?.id ?? 'anonymous'],
    queryFn: () => fetchSandboxAgents(sandboxId!),
    enabled: !isAuthLoading && !!user && !!sandboxId,
    staleTime: 5 * 60 * 1000,
  });
};
