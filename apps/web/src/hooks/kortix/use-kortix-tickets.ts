'use client';

/**
 * Kortix tickets — hooks for tickets, columns, fields, templates, and
 * workspace agents (the "team"). Hits /kortix/tickets and legacy
 * /kortix/projects/:id/* compatibility routes.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { useAuth } from '@/features/providers/auth-provider';
import { getUserHandle } from '@/lib/kortix/user-handle';
import {
  listTickets,
  getTicket,
  listTicketEvents,
  createTicket,
  updateTicket,
  updateTicketStatus,
  assignTicket,
  unassignTicket,
  commentTicket,
  deleteTicket,
  listColumns,
  replaceColumns,
  listFields,
  replaceFields,
  listTemplates,
  replaceTemplates,
  ensurePmSession,
  listProjectAgents,
  createProjectAgent,
  updateProjectAgent,
  deleteProjectAgent,
  getAgentPersona,
  getProjectActivity,
} from '@kortix/sdk/opencode-client';
import type {
  AssigneeType,
  ActorType,
  ExecutionMode,
  ToolGroup,
  TicketAssignee,
  TicketColumn,
  Ticket,
  TicketEvent,
  ProjectField,
  TicketTemplate,
  ProjectAgent,
} from '@kortix/sdk/opencode-client';

// ── Types ────────────────────────────────────────────────────────────────────
// The request/response shapes live in the SDK now (`@kortix/sdk/opencode-client`);
// re-exported here for existing importers.

export type {
  AssigneeType,
  ActorType,
  ExecutionMode,
  ToolGroup,
  TicketAssignee,
  TicketColumn,
  Ticket,
  TicketEvent,
  ProjectField,
  TicketTemplate,
  ProjectAgent,
};

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
    queryFn: () => listTickets(serverUrl, projectId),
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
    queryFn: () => getTicket(serverUrl, id!),
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
    queryFn: () => listTicketEvents(serverUrl, id!),
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
      assign_to?: Array<{ type: AssigneeType; id: string }>;
      milestone_id?: string | null;
      parent_id?: string | null;
    }) =>
      createTicket(serverUrl, {
        ...body,
        actor_type: 'user',
        actor_id: handle,
        created_by_type: 'user',
        created_by_id: handle,
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
    mutationFn: ({ id, ...body }: { id: string; title?: string; body_md?: string; template_id?: string | null; custom_fields?: Record<string, unknown>; milestone_id?: string | null }) =>
      updateTicket(serverUrl, id, { ...body, actor_type: 'user', actor_id: handle }),
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
      updateTicketStatus(serverUrl, id, { status, actor_type: 'user', actor_id: handle }),
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
      assignTicket(serverUrl, id, { assignee_type, assignee_id, actor_type: 'user', actor_id: handle }),
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
      unassignTicket(serverUrl, id, { assignee_type, assignee_id, actor_type: 'user', actor_id: handle }),
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
      commentTicket(serverUrl, id, { body, actor_type: 'user', actor_id: handle }),
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
    mutationFn: (id: string) => deleteTicket(serverUrl, id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kortix', 'tickets'] }); },
  });
}

// ── Columns ──────────────────────────────────────────────────────────────────

export function useColumns(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<TicketColumn[]>({
    queryKey: ticketKeys.columns(projectId ?? ''),
    queryFn: () => listColumns(serverUrl, projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useReplaceColumns() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, columns }: { projectId: string; columns: Array<{ key: string; label: string; default_assignee_type?: AssigneeType | null; default_assignee_id?: string | null; is_terminal?: boolean; is_off_flow?: boolean; icon?: string | null }> }) =>
      replaceColumns(serverUrl, projectId, columns),
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
    queryFn: () => listFields(serverUrl, projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useReplaceFields() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, fields }: { projectId: string; fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'date' | 'select'; options?: string[] | null }> }) =>
      replaceFields(serverUrl, projectId, fields),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.fields(vars.projectId) }); },
  });
}

// ── Templates ────────────────────────────────────────────────────────────────

export function useTemplates(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<TicketTemplate[]>({
    queryKey: ticketKeys.templates(projectId ?? ''),
    queryFn: () => listTemplates(serverUrl, projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useReplaceTemplates() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, templates }: { projectId: string; templates: Array<{ name: string; body_md: string }> }) =>
      replaceTemplates(serverUrl, projectId, templates),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.templates(vars.projectId) }); },
  });
}

// ── PM chat session ──────────────────────────────────────────────────────────

/**
 * Ensure (create-if-missing) a project-level session bound to the Project
 * Manager agent. Idempotent on the backend — first call creates + binds,
 * subsequent calls return the existing session id so the thread continues.
 */
export function useEnsurePmSession() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) => ensurePmSession(serverUrl, projectId),
  });
}

// ── Agents (team) ────────────────────────────────────────────────────────────

export function useProjectAgents(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<ProjectAgent[]>({
    queryKey: ticketKeys.agents(projectId ?? ''),
    queryFn: () => listProjectAgents(serverUrl, projectId!),
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
      createProjectAgent(serverUrl, projectId, {
        slug, name, body_md, execution_mode, tool_groups, default_assignee_columns, default_model, color_hue, icon,
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
    }) => updateProjectAgent(serverUrl, projectId, slug, body),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.agents(vars.projectId) }); },
  });
}

export function useDeleteProjectAgent() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ projectId, slug }: { projectId: string; slug: string }) =>
      deleteProjectAgent(serverUrl, projectId, slug),
    onSuccess: (_d, vars) => { qc.invalidateQueries({ queryKey: ticketKeys.agents(vars.projectId) }); },
  });
}

export function useAgentPersona(projectId?: string, slug?: string, opts?: { enabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<{ agent: ProjectAgent; body_md: string }>({
    queryKey: ['kortix', 'agent-persona', projectId ?? '', slug ?? ''],
    queryFn: () => getAgentPersona(serverUrl, projectId!, slug!),
    enabled: !!projectId && !!slug && (opts?.enabled ?? true),
  });
}

// ── User identity ────────────────────────────────────────────────────────────

export function useUserHandle(): string {
  const { user } = useAuth();
  return getUserHandle(user);
}

// ── Project activity / notifications ─────────────────────────────────────────

export function useProjectActivity(projectId?: string, opts?: { enabled?: boolean; pollingEnabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<TicketEvent[]>({
    queryKey: ['kortix', 'project-activity', projectId ?? ''],
    queryFn: () => getProjectActivity(serverUrl, projectId!, 200),
    enabled: !!projectId && (opts?.enabled ?? true),
    refetchInterval: opts?.pollingEnabled === false ? false : 10_000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export interface UnreadComputation {
  total: number;
  byTicket: Map<string, number>;
  latestAt: string | null;
}

export type NotificationKind = 'mention' | 'assigned' | 'comment-on-mine';

export interface ProjectNotification {
  event: TicketEvent;
  ticket_id: string;
  kind: NotificationKind;
  /** Event that triggered the notification — used to show the comment body when kind='mention'. */
  relatedComment?: TicketEvent | null;
}

/**
 * Count events that are meaningful for the current human:
 *   - they were assigned to this user (user.assignee_id === handle)
 *   - they were @-mentioned in a comment body (message contains `@handle`)
 *   - a teammate commented on a ticket the user is tracking (not implemented;
 *     for v1 the assignment/@-mention covers the critical surface).
 *
 * Filters out events the user themselves produced. Uses the client-side
 * `sinceIso` (usually localStorage last-seen for the project) as the cutoff.
 */
export function computeUnread(
  events: TicketEvent[] | undefined,
  handle: string,
  sinceIso: string | null,
): UnreadComputation {
  const byTicket = new Map<string, number>();
  let latest: string | null = null;
  let total = 0;
  if (!events) return { total, byTicket, latestAt: null };
  const h = handle.toLowerCase();
  const mentionRe = new RegExp(`(^|\\s)@${h.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');

  for (const ev of events) {
    if (sinceIso && ev.created_at <= sinceIso) continue;
    if (!latest || ev.created_at > latest) latest = ev.created_at;
    // Skip events the user themselves initiated (actor_type=user,actor_id=handle).
    if (ev.actor_type === 'user' && (ev.actor_id ?? '').toLowerCase() === h) continue;

    let hit = false;
    if (ev.type === 'assigned') {
      try {
        const p = ev.payload_json ? JSON.parse(ev.payload_json) : null;
        if (p?.assignee_type === 'user' && (p.assignee_id ?? '').toLowerCase() === h) hit = true;
      } catch {}
    } else if (ev.type === 'comment' && ev.message && mentionRe.test(ev.message)) {
      hit = true;
    }
    if (!hit) continue;

    total++;
    byTicket.set(ev.ticket_id, (byTicket.get(ev.ticket_id) ?? 0) + 1);
  }
  return { total, byTicket, latestAt: latest };
}

/**
 * Turn the raw activity stream into a list of user-facing notifications.
 * Scoped to assignments + @mentions, same rule set as computeUnread — we
 * just keep the event itself so the UI can render actor avatars, ticket
 * titles, relative times, and the comment body that caused a mention.
 */
export function computeNotifications(
  events: TicketEvent[] | undefined,
  handle: string,
  sinceIso: string | null,
): ProjectNotification[] {
  if (!events) return [];
  const h = handle.toLowerCase();
  const mentionRe = new RegExp(`(^|\\s)@${h.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
  const out: ProjectNotification[] = [];
  for (const ev of events) {
    if (sinceIso && ev.created_at <= sinceIso) continue;
    if (ev.actor_type === 'user' && (ev.actor_id ?? '').toLowerCase() === h) continue;

    if (ev.type === 'assigned') {
      try {
        const p = ev.payload_json ? JSON.parse(ev.payload_json) : null;
        if (p?.assignee_type === 'user' && (p.assignee_id ?? '').toLowerCase() === h) {
          out.push({ event: ev, ticket_id: ev.ticket_id, kind: 'assigned' });
        }
      } catch {}
    } else if (ev.type === 'comment' && ev.message && mentionRe.test(ev.message)) {
      out.push({ event: ev, ticket_id: ev.ticket_id, kind: 'mention', relatedComment: ev });
    }
  }
  return out;
}

const LAST_SEEN_KEY = (projectId: string, handle: string) => `kortix:activity-last-seen:${projectId}:${handle}`;
export const LAST_SEEN_EVENT = 'kortix:last-seen-changed';

export function readLastSeen(projectId: string, handle: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(LAST_SEEN_KEY(projectId, handle)); } catch { return null; }
}
export function writeLastSeen(projectId: string, handle: string, iso: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_SEEN_KEY(projectId, handle), iso);
    // Same-tab listeners (e.g. the sidebar project rows) don't receive the
    // native 'storage' event — emit a custom one so they refresh instantly.
    window.dispatchEvent(new CustomEvent(LAST_SEEN_EVENT, { detail: { projectId, handle, iso } }));
  } catch {}
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
