'use client';

/**
 * Kortix v2 Tickets — hooks for tickets, columns, fields, templates, and
 * project agents (the "team"). Hits /kortix/tickets and /kortix/projects/:id/*.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { useAuth } from '@/components/AuthProvider';
import { getUserHandle } from '@/lib/kortix/user-handle';

// ── Types ────────────────────────────────────────────────────────────────────

export type AssigneeType = 'user' | 'agent';
export type ActorType = 'user' | 'agent' | 'system';
export type ExecutionMode = 'per_ticket' | 'per_assignment' | 'persistent';
export type ToolGroup = 'project_action' | 'project_manage';

export interface TicketAssignee {
  ticket_id: string;
  assignee_type: AssigneeType;
  assignee_id: string;
  assigned_at: string;
}

export interface TicketColumn {
  id: string;
  project_id: string;
  key: string;
  label: string;
  order_index: number;
  default_assignee_type: AssigneeType | null;
  default_assignee_id: string | null;
  is_terminal: number;
  icon: string | null;
}

export interface Ticket {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body_md: string;
  status: string;
  template_id: string | null;
  custom_fields_json: string;
  created_by_type: ActorType;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  assignees: TicketAssignee[];
  column?: TicketColumn | null;
}

export interface TicketEvent {
  id: string;
  ticket_id: string;
  project_id: string;
  actor_type: ActorType;
  actor_id: string | null;
  type: string;
  message: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface ProjectField {
  id: string;
  project_id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  options_json: string | null;
  order_index: number;
}

export interface TicketTemplate {
  id: string;
  project_id: string;
  name: string;
  body_md: string;
  created_at: string;
}

export interface ProjectAgent {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  file_path: string;
  session_id: string | null;
  execution_mode: ExecutionMode;
  tool_groups_json: string;
  default_assignee_columns_json: string;
  default_model: string | null;
  color_hue: number | null;
  icon: string | null;
  created_at: string;
}

// ── fetch ────────────────────────────────────────────────────────────────────

async function kfetch<T>(serverUrl: string, apiPath: string, init?: RequestInit): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, '')}${apiPath}`;
  const res = await authenticatedFetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kortix API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Query keys ───────────────────────────────────────────────────────────────

export const ticketKeys = {
  tickets: (pid?: string) => ['kortix', 'tickets', pid ?? ''] as const,
  ticket: (id: string) => ['kortix', 'ticket', id] as const,
  events: (id: string) => ['kortix', 'ticket', id, 'events'] as const,
  columns: (pid: string) => ['kortix', 'columns', pid] as const,
  fields: (pid: string) => ['kortix', 'fields', pid] as const,
  templates: (pid: string) => ['kortix', 'templates', pid] as const,
  agents: (pid: string) => ['kortix', 'agents', pid] as const,
};

// ── Tickets ──────────────────────────────────────────────────────────────────

export function useTickets(projectId?: string, opts?: { enabled?: boolean; pollingEnabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<Ticket[]>({
    queryKey: ticketKeys.tickets(projectId),
    queryFn: () =>
      kfetch<Ticket[]>(serverUrl, `/kortix/tickets${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
    enabled: !!projectId && (opts?.enabled ?? true),
    refetchInterval: opts?.pollingEnabled === false ? false : 3000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useTicket(id?: string, opts?: { enabled?: boolean; pollingEnabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<Ticket>({
    queryKey: ticketKeys.ticket(id ?? ''),
    queryFn: () => kfetch<Ticket>(serverUrl, `/kortix/tickets/${encodeURIComponent(id!)}`),
    enabled: !!id && (opts?.enabled ?? true),
    refetchInterval: opts?.pollingEnabled === false ? false : 3000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useTicketEvents(id?: string, opts?: { enabled?: boolean; pollingEnabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<TicketEvent[]>({
    queryKey: ticketKeys.events(id ?? ''),
    queryFn: () => kfetch<TicketEvent[]>(serverUrl, `/kortix/tickets/${encodeURIComponent(id!)}/events`),
    enabled: !!id && (opts?.enabled ?? true),
    refetchInterval: opts?.pollingEnabled === false ? false : 3000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const handle = getUserHandle(user);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (body: {
      project_id: string;
      title: string;
      body_md?: string;
      status?: string;
      template_id?: string | null;
      custom_fields?: Record<string, unknown>;
    }) =>
      kfetch<{ ticket: Ticket; triggered: Array<{ agent_id: string; agent_slug: string; reason: string }> }>(serverUrl, '/kortix/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, actor_type: 'user', actor_id: handle, created_by_type: 'user', created_by_id: handle }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ticketKeys.tickets(vars.project_id) });
    },
  });
}

export function useUpdateTicket() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const handle = getUserHandle(user);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; title?: string; body_md?: string; template_id?: string | null; custom_fields?: Record<string, unknown> }) =>
      kfetch<Ticket>(serverUrl, `/kortix/tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, actor_type: 'user', actor_id: handle }),
      }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ticketKeys.tickets(t.project_id) });
      qc.invalidateQueries({ queryKey: ticketKeys.ticket(t.id) });
      qc.invalidateQueries({ queryKey: ticketKeys.events(t.id) });
    },
  });
}

export function useUpdateTicketStatus() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const handle = getUserHandle(user);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      kfetch<{ ticket: Ticket; triggered: Array<{ agent_id: string; agent_slug: string; reason: string }> }>(serverUrl, `/kortix/tickets/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, actor_type: 'user', actor_id: handle }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ticketKeys.tickets(r.ticket.project_id) });
      qc.invalidateQueries({ queryKey: ticketKeys.ticket(r.ticket.id) });
      qc.invalidateQueries({ queryKey: ticketKeys.events(r.ticket.id) });
    },
  });
}

export function useAssignTicket() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const handle = getUserHandle(user);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, assignee_type, assignee_id }: { id: string; assignee_type: AssigneeType; assignee_id: string }) =>
      kfetch<{ added: boolean; ticket: Ticket }>(serverUrl, `/kortix/tickets/${encodeURIComponent(id)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee_type, assignee_id, actor_type: 'user', actor_id: handle }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ticketKeys.tickets(r.ticket.project_id) });
      qc.invalidateQueries({ queryKey: ticketKeys.ticket(r.ticket.id) });
      qc.invalidateQueries({ queryKey: ticketKeys.events(r.ticket.id) });
    },
  });
}

export function useUnassignTicket() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const handle = getUserHandle(user);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, assignee_type, assignee_id }: { id: string; assignee_type: AssigneeType; assignee_id: string }) =>
      kfetch<{ removed: boolean; ticket: Ticket }>(serverUrl, `/kortix/tickets/${encodeURIComponent(id)}/unassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee_type, assignee_id, actor_type: 'user', actor_id: handle }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ticketKeys.tickets(r.ticket.project_id) });
      qc.invalidateQueries({ queryKey: ticketKeys.ticket(r.ticket.id) });
      qc.invalidateQueries({ queryKey: ticketKeys.events(r.ticket.id) });
    },
  });
}

export function useCommentTicket() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const handle = getUserHandle(user);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      kfetch<{ event: TicketEvent; mentions: string[]; triggered: Array<{ agent_slug: string }> }>(serverUrl, `/kortix/tickets/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, actor_type: 'user', actor_id: handle }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ticketKeys.events(vars.id) });
      qc.invalidateQueries({ queryKey: ticketKeys.ticket(vars.id) });
    },
  });
}

export function useDeleteTicket() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (id: string) =>
      kfetch<{ deleted: true }>(serverUrl, `/kortix/tickets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kortix', 'tickets'] }); },
  });
}

// ── Columns ──────────────────────────────────────────────────────────────────

export function useColumns(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<TicketColumn[]>({
    queryKey: ticketKeys.columns(projectId ?? ''),
    queryFn: () => kfetch<TicketColumn[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/columns`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useReplaceColumns() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, columns }: { projectId: string; columns: Array<{ key: string; label: string; default_assignee_type?: AssigneeType | null; default_assignee_id?: string | null; is_terminal?: boolean; icon?: string | null }> }) =>
      kfetch<TicketColumn[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/columns`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ticketKeys.columns(vars.projectId) });
      qc.invalidateQueries({ queryKey: ticketKeys.tickets(vars.projectId) });
    },
  });
}

// ── Fields ───────────────────────────────────────────────────────────────────

export function useFields(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<ProjectField[]>({
    queryKey: ticketKeys.fields(projectId ?? ''),
    queryFn: () => kfetch<ProjectField[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/fields`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useReplaceFields() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, fields }: { projectId: string; fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'date' | 'select'; options?: string[] | null }> }) =>
      kfetch<ProjectField[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/fields`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      }),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.fields(vars.projectId) }); },
  });
}

// ── Templates ────────────────────────────────────────────────────────────────

export function useTemplates(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<TicketTemplate[]>({
    queryKey: ticketKeys.templates(projectId ?? ''),
    queryFn: () => kfetch<TicketTemplate[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/templates`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useReplaceTemplates() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, templates }: { projectId: string; templates: Array<{ name: string; body_md: string }> }) =>
      kfetch<TicketTemplate[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/templates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templates }),
      }),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.templates(vars.projectId) }); },
  });
}

// ── Agents (team) ────────────────────────────────────────────────────────────

export function useProjectAgents(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<ProjectAgent[]>({
    queryKey: ticketKeys.agents(projectId ?? ''),
    queryFn: () => kfetch<ProjectAgent[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/agents`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useCreateProjectAgent() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({
      projectId, slug, name, body_md, execution_mode, tool_groups, default_assignee_columns, default_model, color_hue, icon,
    }: {
      projectId: string; slug: string; name: string; body_md: string;
      execution_mode?: ExecutionMode; tool_groups?: ToolGroup[]; default_assignee_columns?: string[];
      default_model?: string | null; color_hue?: number | null; icon?: string | null;
    }) =>
      kfetch<ProjectAgent>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, name, body_md, execution_mode, tool_groups, default_assignee_columns, default_model, color_hue, icon }),
      }),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.agents(vars.projectId) }); },
  });
}

export function useUpdateProjectAgent() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, slug, ...body }: {
      projectId: string; slug: string;
      name?: string; body_md?: string;
      execution_mode?: ExecutionMode; tool_groups?: ToolGroup[]; default_assignee_columns?: string[];
      default_model?: string | null; color_hue?: number | null; icon?: string | null;
    }) =>
      kfetch<ProjectAgent>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.agents(vars.projectId) }); },
  });
}

export function useDeleteProjectAgent() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, slug }: { projectId: string; slug: string }) =>
      kfetch<{ deleted: true }>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.agents(vars.projectId) }); },
  });
}

export function useAgentPersona(projectId?: string, slug?: string, opts?: { enabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<{ agent: ProjectAgent; body_md: string }>({
    queryKey: ['kortix', 'agent-persona', projectId ?? '', slug ?? ''],
    queryFn: () =>
      kfetch<{ agent: ProjectAgent; body_md: string }>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/agents/${encodeURIComponent(slug!)}/persona`),
    enabled: !!projectId && !!slug && (opts?.enabled ?? true),
  });
}

// ── User identity ────────────────────────────────────────────────────────────

export function useUserHandle(): string {
  const { user } = useAuth();
  return getUserHandle(user);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function safeParseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export function parseCustomFields(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
