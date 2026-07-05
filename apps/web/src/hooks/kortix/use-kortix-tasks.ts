'use client';

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import {
  listTasks,
  getTask,
  listTaskEvents,
  getTaskStatus,
  createTask,
  updateTask,
  startTask,
  approveTask,
  deleteTask,
} from '@kortix/sdk/opencode-client';
import type { KortixTaskStatus, KortixTask, KortixTaskEvent, KortixTaskLiveStatus } from '@kortix/sdk/opencode-client';

// ---------------------------------------------------------------------------
// Types — the request/response shapes live in the SDK now
// (`@kortix/sdk/opencode-client`); re-exported here for existing importers.
// ---------------------------------------------------------------------------

export type { KortixTaskStatus, KortixTask, KortixTaskEvent, KortixTaskLiveStatus };

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
  return useQuery({
    queryKey: [...taskKeys.all, projectId, status],
    queryFn: async () => {
      const rows = await listTasks(serverUrl, { projectId, status });
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
      const raw = await getTask(serverUrl, id);
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
      const rows = await listTaskEvents(serverUrl, id);
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
      return getTaskStatus(serverUrl, id);
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
    }) => createTask(serverUrl, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useUpdateKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<KortixTask>) => updateTask(serverUrl, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useStartKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id }: { id: string }) => startTask(serverUrl, id),
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
    mutationFn: (id: string) => approveTask(serverUrl, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useDeleteKortixTask() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (id: string) => deleteTask(serverUrl, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}
