'use client';

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';

// ---------------------------------------------------------------------------
// Types — mirror the live /kortix/tasks API contract
// ---------------------------------------------------------------------------

export type KortixTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'input_needed'
  | 'awaiting_review'
  | 'completed'
  | 'cancelled';

export interface KortixTask {
  id: string;
  project_id: string;
  title: string;
  description: string;
  verification_condition: string;
  status: KortixTaskStatus;
  result: string | null;
  verification_summary: string | null;
  blocking_question: string | null;
  owner_session_id: string | null;
  owner_agent: string | null;
  requested_by_session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KortixTaskEvent {
  id: string;
  task_id: string;
  project_id: string;
  session_id: string | null;
  type:
    | 'progress'
    | 'blocker'
    | 'evidence'
    | 'verification_started'
    | 'verification_passed'
    | 'verification_failed'
    | 'delivered';
  message: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface KortixTaskLiveStatus {
  task_id: string;
  status: KortixTaskStatus;
  latest_run_id: string | null;
  run_status: 'running' | 'input_needed' | 'awaiting_review' | 'completed' | 'cancelled' | 'failed' | null;
  owner_session_id: string | null;
  detail: string;
}

interface KortixTaskQueryOptions {
  enabled?: boolean;
  pollingEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

const taskKeys = {
  all: ['kortix', 'tasks'] as const,
  byProject: (projectId: string) => ['kortix', 'tasks', projectId] as const,
  single: (id: string) => ['kortix', 'tasks', 'detail', id] as const,
  events: (id: string) => ['kortix', 'tasks', 'events', id] as const,
  status: (id: string) => ['kortix', 'tasks', 'status', id] as const,
};

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function kortixTaskFetch<T>(serverUrl: string, path: string, init?: RequestInit): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, '')}/kortix/tasks${path}`;
  const res = await authenticatedFetch(url, init);
  if (!res.ok) throw new Error(`Tasks API ${res.status}`);
  return res.json();
}

const VALID_STATUSES: KortixTaskStatus[] = [
  'todo', 'in_progress', 'input_needed', 'awaiting_review',
  'completed', 'cancelled',
];

function normalizeTask(raw: any): KortixTask {
  const status = VALID_STATUSES.includes(raw?.status) ? raw.status : 'todo';
  return {
    id: raw.id,
    project_id: raw.project_id,
    title: raw.title || '',
    description: raw.description || '',
    verification_condition: raw.verification_condition || '',
    status,
    result: raw.result ?? null,
    verification_summary: raw.verification_summary ?? null,
    blocking_question: raw.blocking_question ?? null,
    owner_session_id: raw.owner_session_id ?? null,
    owner_agent: raw.owner_agent ?? null,
    requested_by_session_id: raw.requested_by_session_id ?? null,
    started_at: raw.started_at ?? null,
    completed_at: raw.completed_at ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function useKortixTasks(
  projectId?: string,
  status?: string,
  options: KortixTaskQueryOptions = {},
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', projectId);
  if (status) params.set('status', status);
  const qs = params.toString() ? `?${params}` : '';
  return useQuery({
    queryKey: [...taskKeys.all, projectId, status],
    queryFn: async () => {
      const rows = await kortixTaskFetch<any[]>(serverUrl, qs);
      return Array.isArray(rows) ? rows.map(normalizeTask) : [];
    },
    enabled: !!projectId && (options.enabled ?? true),
    refetchInterval: options.pollingEnabled === false ? false : 3000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useKortixTask(id: string, options: KortixTaskQueryOptions = {}) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery({
    queryKey: taskKeys.single(id),
    queryFn: async () => {
      const raw = await kortixTaskFetch<any>(serverUrl, `/${encodeURIComponent(id)}`);
      return normalizeTask(raw);
    },
    enabled: !!id && (options.enabled ?? true),
    refetchInterval: options.pollingEnabled === false ? false : 3000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useKortixTaskEvents(id: string, options: KortixTaskQueryOptions = {}) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery({
    queryKey: taskKeys.events(id),
    queryFn: async () => {
      const rows = await kortixTaskFetch<KortixTaskEvent[]>(serverUrl, `/${encodeURIComponent(id)}/events`);
      return Array.isArray(rows) ? rows : [];
    },
    enabled: !!id && (options.enabled ?? true),
    refetchInterval: options.pollingEnabled === false ? false : 3000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useKortixTaskStatus(id: string, options: KortixTaskQueryOptions = {}) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery({
    queryKey: taskKeys.status(id),
    queryFn: async () => {
      return kortixTaskFetch<KortixTaskLiveStatus>(serverUrl, `/${encodeURIComponent(id)}/status`);
    },
    enabled: !!id && (options.enabled ?? true),
    refetchInterval: options.pollingEnabled === false ? false : 3000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useCreateKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (data: {
      project_id: string;
      title: string;
      description?: string;
      verification_condition?: string;
      status?: KortixTaskStatus;
    }) =>
      kortixTaskFetch<KortixTask>(serverUrl, '', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useUpdateKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<KortixTask>) =>
      kortixTaskFetch<KortixTask>(serverUrl, `/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useStartKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      kortixTaskFetch<KortixTask>(serverUrl, `/${encodeURIComponent(id)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
      qc.invalidateQueries({ queryKey: ['kortix', 'projects'] });
      if ((task as any)?.project_id) {
        qc.invalidateQueries({ queryKey: ['kortix', 'projects', (task as any).project_id] });
        qc.invalidateQueries({ queryKey: ['kortix', 'projects', (task as any).project_id, 'sessions'] });
      }
    },
  });
}

export function useApproveKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (id: string) =>
      kortixTaskFetch<KortixTask>(serverUrl, `/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useDeleteKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (id: string) =>
      kortixTaskFetch<{ deleted: boolean }>(serverUrl, `/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}
