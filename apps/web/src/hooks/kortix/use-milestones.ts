'use client';

/**
 * Milestone hooks — list/get/create/update/close/reopen/delete/events.
 *
 * Server shape comes from /kortix/projects/:projectId/milestones (see
 * core/kortix-master/src/routes/milestones.ts). The GET list returns
 * milestones-with-progress + percent_complete. The detail endpoint
 * (GET :ref) additionally returns `tickets`.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { authenticatedFetch } from '@/lib/auth-token';
import { useServerStore } from '@/stores/server-store';
import type { Ticket } from './use-kortix-tickets';

export type MilestoneStatus = 'open' | 'closed' | 'cancelled';

export interface MilestoneProgress {
  total: number;
  done: number;
  in_progress: number;
  blocked: number;
  review: number;
  other: number;
}

export interface Milestone {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description_md: string;
  acceptance_md: string;
  status: MilestoneStatus;
  due_at: string | null;
  completed_at: string | null;
  closed_by_type: 'user' | 'agent' | 'system' | null;
  closed_by_id: string | null;
  created_by_type: 'user' | 'agent' | 'system';
  created_by_id: string | null;
  color_hue: number | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
  progress: MilestoneProgress;
  percent_complete: number;
}

export interface MilestoneDetail extends Milestone {
  tickets: Ticket[];
}

export interface MilestoneEvent {
  id: string;
  milestone_id: string;
  project_id: string;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string | null;
  type: string;
  message: string | null;
  payload_json: string | null;
  created_at: string;
}

async function kfetch<T>(serverUrl: string, apiPath: string, init?: RequestInit): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, '')}${apiPath}`;
  const res = await authenticatedFetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kortix API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export const milestoneKeys = {
  list: (pid?: string, status: 'open' | 'closed' | 'all' = 'all') => ['kortix', 'milestones', pid ?? '', status] as const,
  detail: (pid: string, ref: string) => ['kortix', 'milestone', pid, ref] as const,
  events: (pid: string, ref: string) => ['kortix', 'milestone', pid, ref, 'events'] as const,
};

// ── Queries ──────────────────────────────────────────────────────────────────

export function useMilestones(projectId?: string, statusFilter: 'open' | 'closed' | 'all' = 'all') {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<Milestone[]>({
    queryKey: milestoneKeys.list(projectId, statusFilter),
    queryFn: () =>
      kfetch<Milestone[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/milestones?status=${statusFilter}`),
    enabled: !!projectId,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useMilestone(projectId?: string, ref?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<MilestoneDetail>({
    queryKey: milestoneKeys.detail(projectId ?? '', ref ?? ''),
    queryFn: () =>
      kfetch<MilestoneDetail>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/milestones/${encodeURIComponent(ref!)}`),
    enabled: !!projectId && !!ref,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useMilestoneEvents(projectId?: string, ref?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<MilestoneEvent[]>({
    queryKey: milestoneKeys.events(projectId ?? '', ref ?? ''),
    queryFn: () =>
      kfetch<MilestoneEvent[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/milestones/${encodeURIComponent(ref!)}/events`),
    enabled: !!projectId && !!ref,
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface CreateMilestoneInput {
  projectId: string;
  title: string;
  description_md?: string;
  acceptance_md?: string;
  due_at?: string | null;
  color_hue?: number | null;
  icon?: string | null;
}

export function useCreateMilestone() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<Milestone, Error, CreateMilestoneInput>({
    mutationFn: ({ projectId, ...body }) =>
      kfetch<Milestone>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/milestones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['kortix', 'milestones', vars.projectId] });
    },
  });
}

export interface UpdateMilestoneInput {
  projectId: string;
  ref: string;
  patch: Partial<Pick<Milestone, 'title' | 'description_md' | 'acceptance_md' | 'due_at' | 'color_hue' | 'icon'>>;
}

export function useUpdateMilestone() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<Milestone, Error, UpdateMilestoneInput>({
    mutationFn: ({ projectId, ref, patch }) =>
      kfetch<Milestone>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(ref)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['kortix', 'milestones', vars.projectId] });
      qc.invalidateQueries({ queryKey: milestoneKeys.detail(vars.projectId, vars.ref) });
    },
  });
}

export function useCloseMilestone() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<Milestone, Error, { projectId: string; ref: string; summary_md?: string; cancelled?: boolean }>({
    mutationFn: ({ projectId, ref, summary_md, cancelled }) =>
      kfetch<Milestone>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(ref)}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary_md, cancelled }),
      }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['kortix', 'milestones', vars.projectId] });
      qc.invalidateQueries({ queryKey: milestoneKeys.detail(vars.projectId, vars.ref) });
    },
  });
}

export function useReopenMilestone() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<Milestone, Error, { projectId: string; ref: string }>({
    mutationFn: ({ projectId, ref }) =>
      kfetch<Milestone>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(ref)}/reopen`, {
        method: 'POST',
      }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['kortix', 'milestones', vars.projectId] });
      qc.invalidateQueries({ queryKey: milestoneKeys.detail(vars.projectId, vars.ref) });
    },
  });
}

export function useDeleteMilestone() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { projectId: string; ref: string }>({
    mutationFn: ({ projectId, ref }) =>
      kfetch<{ ok: boolean }>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(ref)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['kortix', 'milestones', vars.projectId] });
    },
  });
}

/** Link or unlink a ticket's milestone. Goes through PATCH /kortix/tickets/:id. */
export function useSetTicketMilestone() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<unknown, Error, { projectId: string; ticketId: string; milestoneId: string | null }>({
    mutationFn: ({ ticketId, milestoneId }) =>
      kfetch(serverUrl, `/kortix/tickets/${encodeURIComponent(ticketId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestone_id: milestoneId }),
      }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['kortix', 'milestones', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['kortix', 'tickets', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['kortix', 'ticket', vars.ticketId] });
    },
  });
}
