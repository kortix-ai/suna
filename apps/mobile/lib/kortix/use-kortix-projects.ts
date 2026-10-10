/**
 * Kortix Projects hooks — ported from apps/web/src/hooks/kortix/use-kortix-projects.ts
 *
 * Reads kortix-master's /kortix/projects and /kortix/tasks through `@kortix/sdk`
 * (`runtime/kortix-master.ts`). That client is @deprecated: kortixd answers
 * every /kortix/projects and /kortix/tasks route with 404 `unknown kortix
 * route`, so ProjectDetailPage shows its error state on every current sandbox.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  approveTask,
  createTask,
  deleteKortixProject,
  deleteTask,
  getKortixProject,
  listKortixProjectSessions,
  listTasks,
  patchKortixProject,
  startTask,
  updateTask,
} from '@kortix/sdk';

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

// ── Query keys ───────────────────────────────────────────────────────────────

export const kortixKeys = {
  projects: (url: string) => ['kortix', 'projects', url] as const,
  project: (url: string, id: string) => ['kortix', 'projects', url, id] as const,
  projectSessions: (url: string, id: string) =>
    ['kortix', 'projects', url, id, 'sessions'] as const,
  tasks: (url: string, projectId: string) => ['kortix', 'tasks', url, projectId] as const,
};

// ── Project hooks ────────────────────────────────────────────────────────────

export function useKortixProject(sandboxUrl: string | undefined, id: string) {
  return useQuery<KortixProject>({
    queryKey: kortixKeys.project(sandboxUrl || '', id),
    queryFn: () => getKortixProject(sandboxUrl!, id) as Promise<KortixProject>,
    enabled: !!sandboxUrl && !!id,
    staleTime: 15_000,
    retry: 2,
  });
}

export function useKortixProjectSessions(sandboxUrl: string | undefined, projectId: string) {
  return useQuery<any[]>({
    queryKey: kortixKeys.projectSessions(sandboxUrl || '', projectId),
    queryFn: () => listKortixProjectSessions(sandboxUrl!, projectId),
    enabled: !!sandboxUrl && !!projectId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export function useKortixTasks(sandboxUrl: string | undefined, projectId: string | undefined) {
  return useQuery<KortixTask[]>({
    queryKey: kortixKeys.tasks(sandboxUrl || '', projectId || ''),
    queryFn: async () => {
      const rows = await listTasks(sandboxUrl!, { projectId });
      return Array.isArray(rows) ? rows.map(normalizeTask) : [];
    },
    enabled: !!sandboxUrl && !!projectId,
    refetchInterval: 5000,
    retry: 2,
  });
}

// ── Mutation hooks ───────────────────────────────────────────────────────────

export function useUpdateProject(sandboxUrl: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; description?: string }) =>
      patchKortixProject(sandboxUrl!, id, data),
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
    mutationFn: (id: string) => deleteKortixProject(sandboxUrl!, id),
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
      const raw = await createTask(sandboxUrl!, data);
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
      const raw = await updateTask(sandboxUrl!, id, data);
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
    mutationFn: async ({ id }: { id: string }) => {
      const raw = await startTask(sandboxUrl!, id);
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
      const raw = await approveTask(sandboxUrl!, id);
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
    mutationFn: (id: string) => deleteTask(sandboxUrl!, id),
    onSuccess: () => {
      if (sandboxUrl) {
        qc.invalidateQueries({ queryKey: ['kortix', 'tasks', sandboxUrl] });
      }
    },
  });
}
