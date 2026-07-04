'use client';

/**
 * Milestone hooks — list/get/create/update/close/reopen/delete/events.
 *
 * Server shape comes from legacy /kortix/projects/:projectId/milestones (see
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
import { useServerStore } from '@/stores/server-store';
import {
  listMilestones,
  getMilestone,
  listMilestoneEvents,
  createMilestone,
  updateMilestone,
  closeMilestone,
  reopenMilestone,
  deleteMilestone,
  updateTicket,
} from '@kortix/sdk/opencode-client';
import type { MilestoneStatus, MilestoneProgress, Milestone, MilestoneDetail, MilestoneEvent } from '@kortix/sdk/opencode-client';

// The request/response shapes live in the SDK now (`@kortix/sdk/opencode-client`);
// re-exported here for existing importers.
export type { MilestoneStatus, MilestoneProgress, Milestone, MilestoneDetail, MilestoneEvent };

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
    queryFn: () => listMilestones(serverUrl, projectId!, statusFilter),
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
    queryFn: () => getMilestone(serverUrl, projectId!, ref!),
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
    queryFn: () => listMilestoneEvents(serverUrl, projectId!, ref!),
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
    mutationFn: ({ projectId, ...body }) => createMilestone(serverUrl, projectId, body),
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
    mutationFn: ({ projectId, ref, patch }) => updateMilestone(serverUrl, projectId, ref, patch),
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
      closeMilestone(serverUrl, projectId, ref, { summary_md, cancelled }),
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
    mutationFn: ({ projectId, ref }) => reopenMilestone(serverUrl, projectId, ref),
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
    mutationFn: ({ projectId, ref }) => deleteMilestone(serverUrl, projectId, ref),
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
    mutationFn: ({ ticketId, milestoneId }) => updateTicket(serverUrl, ticketId, { milestone_id: milestoneId }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['kortix', 'milestones', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['kortix', 'tickets', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['kortix', 'ticket', vars.ticketId] });
    },
  });
}
