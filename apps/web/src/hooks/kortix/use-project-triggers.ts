'use client';

/**
 * Project-scoped triggers hooks. Talks to /kortix/projects/:id/triggers.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';

export interface ProjectTrigger {
  id: string;
  name: string;
  description: string | null;
  source_type: 'cron' | 'webhook';
  source_config: Record<string, unknown>;
  action_type: 'prompt' | 'command' | 'http';
  action_config: Record<string, unknown>;
  agent_name: string | null;
  model_id: string | null;
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  event_count: number;
  created_at: string;
  updated_at: string;
}

export interface TriggerExecution {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  session_id: string | null;
  http_status: number | null;
  duration_ms: number | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

async function kfetch<T>(serverUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await authenticatedFetch(`${serverUrl}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const keys = {
  list: (pid: string) => ['kortix', 'project-triggers', pid] as const,
  executions: (pid: string, tid: string) => ['kortix', 'project-triggers', pid, tid, 'executions'] as const,
};

export function useProjectTriggers(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<{ project_id: string; triggers: ProjectTrigger[] }>({
    queryKey: keys.list(projectId ?? ''),
    queryFn: () => kfetch(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/triggers`),
    enabled: !!projectId,
    staleTime: 10_000,
  });
}

export function useTriggerExecutions(projectId: string, triggerId?: string, limit = 20) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<{ executions: TriggerExecution[] }>({
    queryKey: [...keys.executions(projectId, triggerId ?? ''), limit],
    queryFn: () =>
      kfetch(
        serverUrl,
        `/kortix/projects/${encodeURIComponent(projectId)}/triggers/${encodeURIComponent(triggerId!)}/executions?limit=${limit}`,
      ),
    enabled: !!projectId && !!triggerId,
    staleTime: 5_000,
  });
}

export interface CreateTriggerInput {
  name: string;
  description?: string;
  source: {
    type: 'cron' | 'webhook';
    cron_expr?: string;
    timezone?: string;
    path?: string;
    method?: string;
    secret?: string;
  };
  action: {
    type: 'prompt' | 'command' | 'http';
    prompt?: string;
    agent?: string;
    model?: string;
    session_mode?: 'new' | 'reuse';
    command?: string;
    args?: string[];
    url?: string;
    body_template?: string;
    headers?: Record<string, string>;
  };
}

export function useCreateProjectTrigger() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: CreateTriggerInput }) =>
      kfetch(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/triggers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: keys.list(vars.projectId) }),
  });
}

export function useRunProjectTrigger() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, triggerId }: { projectId: string; triggerId: string }) =>
      kfetch(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/triggers/${encodeURIComponent(triggerId)}/run`, {
        method: 'POST',
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: keys.list(vars.projectId) });
      qc.invalidateQueries({ queryKey: keys.executions(vars.projectId, vars.triggerId) });
    },
  });
}

export function usePauseProjectTrigger() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, triggerId, resume }: { projectId: string; triggerId: string; resume?: boolean }) =>
      kfetch(
        serverUrl,
        `/kortix/projects/${encodeURIComponent(projectId)}/triggers/${encodeURIComponent(triggerId)}/${resume ? 'resume' : 'pause'}`,
        { method: 'POST' },
      ),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: keys.list(vars.projectId) }),
  });
}

export function useDeleteProjectTrigger() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, triggerId }: { projectId: string; triggerId: string }) =>
      kfetch(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/triggers/${encodeURIComponent(triggerId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: keys.list(vars.projectId) }),
  });
}
