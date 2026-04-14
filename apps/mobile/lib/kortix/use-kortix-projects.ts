/**
 * Kortix Projects hooks — ported from apps/web/src/hooks/kortix/use-kortix-projects.ts
 *
 * Fetches from kortix-master's /kortix/projects API through the sandbox URL.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAuthToken } from '@/api/config';

// ── Types ────────────────────────────────────────────────────────────────────

export interface KortixProject {
  id: string;
  name: string;
  path: string;
  description: string;
  created_at: string;
  opencode_id: string | null;
  sessionCount?: number;
  // Extended properties from OpenCode Project
  worktree?: string;
  time?: {
    created: number;
    updated: number;
    initialized?: number;
  };
}

// Task status — aligned with the live Kortix task pipeline.
// Pipeline: todo → [START] → in_progress → input_needed/awaiting_review → [APPROVE] → completed
export type KortixTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'input_needed'
  | 'awaiting_review'
  | 'completed'
  | 'cancelled';

const VALID_TASK_STATUSES: KortixTaskStatus[] = [
  'todo',
  'in_progress',
  'input_needed',
  'awaiting_review',
  'completed',
  'cancelled',
];

/** Map legacy statuses from older backends to the new schema */
function normalizeTaskStatus(status: unknown): KortixTaskStatus {
  if (typeof status !== 'string') return 'todo';
  if ((VALID_TASK_STATUSES as string[]).includes(status)) return status as KortixTaskStatus;
  // Back-compat mapping for pre-26cf37f data
  if (status === 'pending') return 'todo';
  if (status === 'done') return 'completed';
  if (status === 'blocked') return 'input_needed';
  return 'todo';
}

function normalizeTask(raw: any): KortixTask {
  return {
    id: raw.id,
    project_id: raw.project_id,
    title: raw.title || '',
    description: raw.description || '',
    verification_condition: raw.verification_condition || '',
    status: normalizeTaskStatus(raw?.status),
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

export interface KortixAgent {
  id: string;
  project_id: string;
  session_id: string;
  parent_session_id: string;
  agent_type: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  result: string | null;
  verification_summary: string | null;
  blocking_question: string | null;
  owner_session_id: string | null;
  owner_agent: string | null;
  requested_by_session_id?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

async function kortixFetch<T>(sandboxUrl: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const url = `${sandboxUrl.replace(/\/+$/, '')}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kortix API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Query keys ───────────────────────────────────────────────────────────────

export const kortixKeys = {
  projects: (url: string) => ['kortix', 'projects', url] as const,
  project: (url: string, id: string) => ['kortix', 'projects', url, id] as const,
  projectSessions: (url: string, id: string) =>
    ['kortix', 'projects', url, id, 'sessions'] as const,
  tasks: (url: string, projectId: string) => ['kortix', 'tasks', url, projectId] as const,
  agents: (url: string, projectId: string) => ['kortix', 'agents', url, projectId] as const,
};

// ── Project hooks ────────────────────────────────────────────────────────────

export function useKortixProjects(sandboxUrl: string | undefined) {
  return useQuery<KortixProject[]>({
    queryKey: kortixKeys.projects(sandboxUrl || ''),
    queryFn: () => kortixFetch<KortixProject[]>(sandboxUrl!, '/kortix/projects'),
    enabled: !!sandboxUrl,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export function useKortixProject(sandboxUrl: string | undefined, id: string) {
  return useQuery<KortixProject>({
    queryKey: kortixKeys.project(sandboxUrl || '', id),
    queryFn: () =>
      kortixFetch<KortixProject>(sandboxUrl!, `/kortix/projects/${encodeURIComponent(id)}`),
    enabled: !!sandboxUrl && !!id,
    staleTime: 15_000,
    retry: 2,
  });
}

export function useKortixProjectSessions(sandboxUrl: string | undefined, projectId: string) {
  return useQuery<any[]>({
    queryKey: kortixKeys.projectSessions(sandboxUrl || '', projectId),
    queryFn: () =>
      kortixFetch<any[]>(sandboxUrl!, `/kortix/projects/${encodeURIComponent(projectId)}/sessions`),
    enabled: !!sandboxUrl && !!projectId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export function useKortixTasks(sandboxUrl: string | undefined, projectId: string | undefined) {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return useQuery<KortixTask[]>({
    queryKey: kortixKeys.tasks(sandboxUrl || '', projectId || ''),
    queryFn: async () => {
      const rows = await kortixFetch<any[]>(sandboxUrl!, `/kortix/tasks${qs}`);
      return Array.isArray(rows) ? rows.map(normalizeTask) : [];
    },
    enabled: !!sandboxUrl && !!projectId,
    refetchInterval: 5000,
    retry: 2,
  });
}

/** Fetch a single task by ID (ported from web 26cf37f). */
export function useKortixTask(sandboxUrl: string | undefined, id: string | undefined) {
  return useQuery<KortixTask>({
    queryKey: ['kortix', 'tasks', sandboxUrl || '', 'detail', id || ''],
    queryFn: async () => {
      const raw = await kortixFetch<any>(sandboxUrl!, `/kortix/tasks/${encodeURIComponent(id!)}`);
      return normalizeTask(raw);
    },
    enabled: !!sandboxUrl && !!id,
    refetchInterval: 5000,
    retry: 2,
  });
}

export function useKortixAgents(sandboxUrl: string | undefined, projectId: string | undefined) {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return useQuery<KortixAgent[]>({
    queryKey: kortixKeys.agents(sandboxUrl || '', projectId || ''),
    queryFn: async () => {
      try {
        return await kortixFetch<KortixAgent[]>(sandboxUrl!, `/kortix/agents${qs}`);
      } catch {
        return [];
      }
    },
    enabled: !!sandboxUrl && !!projectId,
    refetchInterval: 5000,
  });
}
// ── Mutation hooks ───────────────────────────────────────────────────────────

export function useUpdateProject(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; description?: string }) =>
      kortixFetch<KortixProject>(sandboxUrl!, `/kortix/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: (_, vars) => {
      if (sandboxUrl) {
        qc.invalidateQueries({ queryKey: kortixKeys.project(sandboxUrl, vars.id) });
        qc.invalidateQueries({ queryKey: kortixKeys.projects(sandboxUrl) });
      }
    },
  });
}

export function useDeleteProject(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      kortixFetch<{ deleted: boolean; name: string; path: string }>(
        sandboxUrl!,
        `/kortix/projects/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        }
      ),
    onSuccess: () => {
      if (sandboxUrl) {
        qc.invalidateQueries({ queryKey: kortixKeys.projects(sandboxUrl) });
      }
    },
  });
}

// ── Task mutation hooks (ported from web 8e1bc7b + 26cf37f) ─────────────────

export function useCreateKortixTask(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      project_id: string;
      title: string;
      description?: string;
      verification_condition?: string;
      status?: KortixTaskStatus;
    }) => {
      const raw = await kortixFetch<any>(sandboxUrl!, `/kortix/tasks`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return normalizeTask(raw);
    },
    onSuccess: () => {
      if (sandboxUrl) {
        qc.invalidateQueries({ queryKey: ['kortix', 'tasks', sandboxUrl] });
      }
    },
  });
}

export function useUpdateKortixTask(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: string } & Partial<KortixTask>) => {
      const raw = await kortixFetch<any>(sandboxUrl!, `/kortix/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      return normalizeTask(raw);
    },
    onSuccess: () => {
      if (sandboxUrl) {
        // Invalidate all task queries for this sandbox
        qc.invalidateQueries({ queryKey: ['kortix', 'tasks', sandboxUrl] });
      }
    },
  });
}

/** Start a task — transitions it from `todo` → `in_progress` (ported from web 26cf37f) */
export function useStartKortixTask(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      session_id,
      agent,
    }: {
      id: string;
      session_id?: string;
      agent?: string;
    }) => {
      const raw = await kortixFetch<any>(
        sandboxUrl!,
        `/kortix/tasks/${encodeURIComponent(id)}/start`,
        {
          method: 'POST',
          body: JSON.stringify({ session_id, agent }),
        }
      );
      return normalizeTask(raw);
    },
    onSuccess: () => {
      if (sandboxUrl) {
        qc.invalidateQueries({ queryKey: ['kortix', 'tasks', sandboxUrl] });
      }
    },
  });
}

/** Approve a task waiting for input/review — transitions it to `completed` (ported from web 26cf37f) */
export function useApproveKortixTask(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const raw = await kortixFetch<any>(
        sandboxUrl!,
        `/kortix/tasks/${encodeURIComponent(id)}/approve`,
        {
          method: 'POST',
        }
      );
      return normalizeTask(raw);
    },
    onSuccess: () => {
      if (sandboxUrl) {
        qc.invalidateQueries({ queryKey: ['kortix', 'tasks', sandboxUrl] });
      }
    },
  });
}

export function useDeleteKortixTask(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      kortixFetch<{ deleted: boolean }>(sandboxUrl!, `/kortix/tasks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      if (sandboxUrl) {
        qc.invalidateQueries({ queryKey: ['kortix', 'tasks', sandboxUrl] });
      }
    },
  });
}
