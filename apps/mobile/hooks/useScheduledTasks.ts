/**
 * React Query hooks for Scheduled Tasks / Triggers.
 * Mirrors the frontend's use-scheduled-tasks.ts against the sandbox OpenCode endpoints.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getAuthToken } from '@/api/config';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SessionMode = 'new' | 'reuse';
export type TriggerType = 'cron' | 'webhook';
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
  retryCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  trigger_name?: string;
}

export interface CreateTriggerData {
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
    type?: 'prompt' | 'command' | 'http';
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
  metadata?: Record<string, unknown>;
}

export interface UpdateTriggerData {
  name?: string;
  description?: string | null;
  cron_expr?: string;
  timezone?: string;
  agent_name?: string | null;
  model_provider_id?: string | null;
  model_id?: string | null;
  prompt?: string;
  session_mode?: SessionMode;
  is_active?: boolean;
  max_retries?: number;
  timeout_ms?: number;
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

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

/** Authenticated fetch against the sandbox — same pattern as opencodeFetch in platform/hooks */
async function sandboxFetch<T>(sandboxUrl: string, path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// ─── API Functions ───────────────────────────────────────────────────────────

async function fetchTriggers(sandboxUrl: string): Promise<Trigger[]> {
  const api = await sandboxFetch<ApiListResponse>(sandboxUrl, '/kortix/triggers');
  return (api.data || []).map((t) => ({
    ...t,
    maxRetries: t.maxRetries ?? 0,
    timeoutMs: t.timeoutMs ?? 300000,
    metadata: t.metadata ?? {},
    isActive: t.isActive ?? t.enabled ?? true,
  }));
}

async function fetchTrigger(sandboxUrl: string, triggerId: string): Promise<Trigger> {
  const res = await sandboxFetch<ApiSingleResponse>(sandboxUrl, `/kortix/cron/triggers/${triggerId}`);
  return res.data;
}

async function createTrigger(sandboxUrl: string, data: CreateTriggerData): Promise<Trigger> {
  const res = await sandboxFetch<ApiSingleResponse>(sandboxUrl, '/kortix/triggers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

async function updateTrigger(sandboxUrl: string, id: string, data: UpdateTriggerData): Promise<Trigger> {
  const res = await sandboxFetch<ApiSingleResponse>(sandboxUrl, `/kortix/cron/triggers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return res.data;
}

async function deleteTrigger(sandboxUrl: string, id: string): Promise<void> {
  await sandboxFetch(sandboxUrl, `/kortix/cron/triggers/${id}`, { method: 'DELETE' });
}

async function pauseTrigger(sandboxUrl: string, id: string): Promise<Trigger> {
  const res = await sandboxFetch<ApiSingleResponse>(sandboxUrl, `/kortix/cron/triggers/${id}/pause`, { method: 'POST' });
  return res.data;
}

async function resumeTrigger(sandboxUrl: string, id: string): Promise<Trigger> {
  const res = await sandboxFetch<ApiSingleResponse>(sandboxUrl, `/kortix/cron/triggers/${id}/resume`, { method: 'POST' });
  return res.data;
}

async function runTrigger(sandboxUrl: string, id: string): Promise<{ execution_id: string; status: string; message: string }> {
  const res = await sandboxFetch<ApiRunResponse>(sandboxUrl, `/kortix/cron/triggers/${id}/run`, { method: 'POST' });
  return res.data;
}

async function fetchExecutions(sandboxUrl: string, triggerId: string, limit = 50, offset = 0): Promise<Execution[]> {
  const res = await sandboxFetch<ApiExecutionsResponse>(
    sandboxUrl,
    `/kortix/cron/executions/by-trigger/${triggerId}?limit=${limit}&offset=${offset}`,
  );
  return res.data;
}

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const scheduledTaskKeys = {
  all: ['scheduled-tasks'] as const,
  triggers: () => [...scheduledTaskKeys.all, 'triggers'] as const,
  trigger: (id: string) => [...scheduledTaskKeys.all, 'trigger', id] as const,
  executions: (id: string) => [...scheduledTaskKeys.all, 'executions', id] as const,
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useScheduledTasks() {
  const { sandboxUrl } = useSandboxContext();
  return useQuery({
    queryKey: scheduledTaskKeys.triggers(),
    queryFn: () => fetchTriggers(sandboxUrl!),
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useScheduledTask(triggerId: string) {
  const { sandboxUrl } = useSandboxContext();
  return useQuery({
    queryKey: scheduledTaskKeys.trigger(triggerId),
    queryFn: () => fetchTrigger(sandboxUrl!, triggerId),
    enabled: !!sandboxUrl && !!triggerId,
    staleTime: 60 * 1000,
  });
}

export function useCreateScheduledTask() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTriggerData) => createTrigger(sandboxUrl!, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scheduledTaskKeys.triggers() });
    },
  });
}

export function useUpdateScheduledTask() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTriggerData }) => updateTrigger(sandboxUrl!, id, data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: scheduledTaskKeys.triggers() });
      if (updated.triggerId) {
        qc.invalidateQueries({ queryKey: scheduledTaskKeys.trigger(updated.triggerId) });
      }
    },
  });
}

export function useDeleteScheduledTask() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTrigger(sandboxUrl!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scheduledTaskKeys.triggers() });
    },
  });
}

export function useToggleScheduledTask() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      isActive ? resumeTrigger(sandboxUrl!, id) : pauseTrigger(sandboxUrl!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scheduledTaskKeys.triggers() });
    },
  });
}

export function useRunScheduledTask() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runTrigger(sandboxUrl!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scheduledTaskKeys.all });
    },
  });
}

export function useTaskExecutions(triggerId: string, limit = 50) {
  const { sandboxUrl } = useSandboxContext();
  return useQuery({
    queryKey: scheduledTaskKeys.executions(triggerId),
    queryFn: () => fetchExecutions(sandboxUrl!, triggerId, limit),
    enabled: !!sandboxUrl && !!triggerId,
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Convert a 6-field cron expression to a human-readable description */
export function describeCron(expr: string | null | undefined): string {
  if (!expr) return 'No schedule';
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;

  // Handle 6-field (with seconds) or 5-field cron
  const [sec, min, hour, dom, mon, dow] = parts.length === 6
    ? parts
    : ['0', ...parts];

  // Every N minutes
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*') {
    const interval = parseInt(min.slice(2), 10);
    if (interval === 1) return 'Every minute';
    return `Every ${interval} minutes`;
  }

  // Every N hours
  if (hour.startsWith('*/') && dom === '*' && mon === '*') {
    const interval = parseInt(hour.slice(2), 10);
    if (interval === 1) return 'Every hour';
    return `Every ${interval} hours`;
  }

  // Daily at specific time
  if (dom === '*' && mon === '*' && (dow === '*' || dow === '?') && !hour.includes('/') && !hour.includes(',')) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return `Daily at ${timeStr}`;
  }

  // Weekly
  if (dom === '*' && mon === '*' && dow !== '*' && dow !== '?') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = dow.split(',').map((d) => {
      const num = parseInt(d, 10);
      return dayNames[num] || d;
    }).join(', ');
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return `${days} at ${timeStr}`;
  }

  // Monthly
  if (dom !== '*' && mon === '*' && (dow === '*' || dow === '?')) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return `Monthly on day ${dom} at ${timeStr}`;
  }

  return expr;
}

/** Format a relative time string like "2h ago" or "in 5m" */
export function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const abs = Math.abs(diffMs);
  const future = diffMs < 0;

  if (abs < 60_000) return future ? 'in <1m' : '<1m ago';
  if (abs < 3600_000) {
    const m = Math.floor(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86400_000) {
    const h = Math.floor(abs / 3600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.floor(abs / 86400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

/** Format milliseconds duration */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
