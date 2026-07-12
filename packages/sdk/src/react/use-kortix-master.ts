'use client';

/**
 * kortix-master React Query layer — the generic (host-agnostic) hooks over
 * the `./kortix-master` transport client: query keys, caching/polling config,
 * optimistic-update/invalidation wiring, and the pure normalization/derivation
 * helpers that used to live inline in six apps/web hook files
 * (`use-credentials.ts`, `use-kortix-projects.ts`, `use-kortix-tasks.ts`,
 * `use-kortix-tickets.ts`, `use-milestones.ts`, `use-sandbox-services.ts`).
 *
 * Everything here is transport + cache plumbing — it has zero knowledge of
 * any host's auth stack. The one thing the original web hooks pulled from
 * `useAuth()`/`getUserHandle()` (the current human's id + derived @handle,
 * used to partition query-cache keys and to stamp audit/authorship fields on
 * ticket mutations) is threaded through as an explicit `identity` parameter
 * (`KortixMasterIdentity`) instead — see that type below. Any host (web,
 * mobile, whitelabel-demo, …) supplies its own identity and gets the same
 * hooks.
 *
 * The "active server" resolution (which sandbox these calls hit) does NOT
 * need injecting: `useServerStore`/`getActiveRuntimeUrl` (`../state/server-store`)
 * is already a host-agnostic part of this SDK — apps/web's
 * `@/stores/server-store` is already just a re-export of it. Hooks here use
 * it directly, exactly like the existing `./use-runtime-reconnect` and
 * `./use-runtime-events` SDK hooks do.
 *
 * Query keys below are copied VERBATIM from the pre-migration web hooks
 * (array literal contents, ordering, and types unchanged) — this is a hard
 * cache-compatibility requirement, not a style choice.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { useServerStore } from '../browser/stores/server-store';
import {
  // Credentials
  listCredentials,
  listCredentialEvents,
  upsertCredential,
  revealCredential,
  deleteCredential,
  // Projects
  listKortixProjects,
  getKortixProject,
  getKortixProjectBySession,
  listKortixProjectSessions,
  deleteKortixProject,
  patchKortixProject,
  // Tasks
  listTasks,
  getTask,
  listTaskEvents,
  getTaskStatus,
  createTask,
  updateTask,
  startTask,
  approveTask,
  deleteTask,
  // Tickets
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
  // Milestones
  listMilestones,
  getMilestone,
  listMilestoneEvents,
  createMilestone,
  updateMilestone,
  closeMilestone,
  reopenMilestone,
  deleteMilestone,
  // Services
  listServices,
  listServiceTemplates,
  getServiceLogs,
  serviceAction as sdkServiceAction,
  reconcileServices,
  registerService,
  systemReload,
} from '../core/runtime/client';
import type {
  CredentialItem,
  CredentialWithValue,
  CredentialEvent,
  KortixProject,
  KortixTaskStatus,
  KortixTask,
  KortixTaskEvent,
  KortixTaskLiveStatus,
  AssigneeType,
  ActorType,
  ExecutionMode,
  ToolGroup,
  TicketAssignee,
  Ticket,
  TicketEvent,
  TicketColumn,
  ProjectField,
  TicketTemplate,
  ProjectAgent,
  MilestoneStatus,
  MilestoneProgress,
  Milestone,
  MilestoneDetail,
  MilestoneEvent,
  SandboxServiceStatus,
  SandboxServiceAdapter,
  SandboxServiceScope,
  SandboxService,
  SandboxServiceTemplate,
  RegisterSandboxServicePayload,
  SandboxServiceAction,
  SystemReloadMode,
} from '../core/runtime/client';

// Re-export the request/response types unchanged for hosts consuming this
// module directly.
export type {
  CredentialItem,
  CredentialWithValue,
  CredentialEvent,
  KortixProject,
  KortixTaskStatus,
  KortixTask,
  KortixTaskEvent,
  KortixTaskLiveStatus,
  AssigneeType,
  ActorType,
  ExecutionMode,
  ToolGroup,
  TicketAssignee,
  Ticket,
  TicketEvent,
  TicketColumn,
  ProjectField,
  TicketTemplate,
  ProjectAgent,
  MilestoneStatus,
  MilestoneProgress,
  Milestone,
  MilestoneDetail,
  MilestoneEvent,
  SandboxServiceStatus,
  SandboxServiceAdapter,
  SandboxServiceScope,
  SandboxService,
  SandboxServiceTemplate,
  RegisterSandboxServicePayload,
};
export type ServiceAction = SandboxServiceAction;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable actor identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one seam between this module and a host's auth stack. Replaces the
 * former direct `useAuth()` + `getUserHandle()` calls inline in the web
 * hooks:
 *  - `userId` / `isLoading` partition query-cache keys and gate `enabled` the
 *    same way `user?.id` / `isAuthLoading` did.
 *  - `handle` stamps `actor_id`/`created_by_id` on ticket mutations the same
 *    way `getUserHandle(user)` did.
 *
 * A host supplies this however it derives identity (Supabase session, a
 * mobile auth SDK, a service-account token, …) — this module never imports
 * an auth library itself.
 */
export interface KortixMasterIdentity {
  userId: string | null;
  handle: string;
  isLoading: boolean;
}

// ═════════════════════════════════════════════════════════════════════════
// Credentials — /kortix/projects/:id/credentials
// ═════════════════════════════════════════════════════════════════════════

export const credentialKeys = {
  list: (pid?: string) => ['kortix', 'credentials', pid ?? ''] as const,
  events: (pid: string, name: string) => ['kortix', 'credentials', pid, name, 'events'] as const,
};

export function useCredentials(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<CredentialItem[]>({
    queryKey: credentialKeys.list(projectId),
    queryFn: () => listCredentials(serverUrl, projectId!),
    enabled: !!projectId,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useCredentialEvents(projectId?: string, name?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<CredentialEvent[]>({
    queryKey: credentialKeys.events(projectId ?? '', name ?? ''),
    queryFn: () => listCredentialEvents(serverUrl, projectId!, name!),
    enabled: !!projectId && !!name,
    refetchInterval: 10_000,
  });
}

export function useUpsertCredential() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<CredentialItem, Error, {
    projectId: string;
    name: string;
    value: string;
    description?: string | null;
  }>({
    mutationFn: ({ projectId, ...body }) => upsertCredential(serverUrl, projectId, body),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: credentialKeys.list(vars.projectId) });
    },
  });
}

/** Reveal returns the decrypted value. Each call is audit-logged as a read. */
export function useRevealCredential() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<CredentialWithValue, Error, { projectId: string; name: string }>({
    mutationFn: ({ projectId, name }) => revealCredential(serverUrl, projectId, name),
    onSuccess: (_res, vars) => {
      // Refresh list so last_read_at updates on the card
      qc.invalidateQueries({ queryKey: credentialKeys.list(vars.projectId) });
      qc.invalidateQueries({ queryKey: credentialKeys.events(vars.projectId, vars.name) });
    },
  });
}

export function useDeleteCredential() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { projectId: string; name: string }>({
    mutationFn: ({ projectId, name }) => deleteCredential(serverUrl, projectId, name),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: credentialKeys.list(vars.projectId) });
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Kortix projects — /kortix/projects
// ═════════════════════════════════════════════════════════════════════════

export const kortixKeys = {
  projects: () => ['kortix', 'projects'] as const,
  project: (id: string) => ['kortix', 'projects', id] as const,
};

export interface KortixProjectQueryOptions {
  enabled?: boolean;
}

export function useKortixProjects(
  identity: KortixMasterIdentity,
  _args?: undefined,
  options: KortixProjectQueryOptions = {},
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject[]>({
    queryKey: [...kortixKeys.projects(), identity.userId ?? 'anonymous', serverUrl],
    queryFn: () => listKortixProjects(serverUrl),
    enabled: !identity.isLoading && !!identity.userId && !!serverUrl && (options.enabled ?? true),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  });
}

export function useKortixProject(identity: KortixMasterIdentity, id: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject>({
    queryKey: [...kortixKeys.project(id), identity.userId ?? 'anonymous', serverUrl],
    queryFn: () => getKortixProject(serverUrl, id),
    enabled: !identity.isLoading && !!identity.userId && !!serverUrl && !!id,
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
    retry: 2,
    // Keep previous data while a new query (e.g. from a runtime URL change)
    // is loading. Prevents the skeleton flash.
    placeholderData: keepPreviousData,
  });
}

export function useKortixProjectForSession(
  identity: KortixMasterIdentity,
  sessionId: string,
  options: KortixProjectQueryOptions = {},
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject | null>({
    queryKey: ['kortix', 'projects', 'by-session', sessionId, identity.userId ?? 'anonymous', serverUrl],
    queryFn: async () => {
      try {
        return await getKortixProjectBySession(serverUrl, sessionId);
      } catch {
        return null;
      }
    },
    enabled: !identity.isLoading && !!identity.userId && !!serverUrl && !!sessionId && (options.enabled ?? true),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch sessions linked to a specific project.
 * Returns Runtime session objects enriched with title, time, etc.
 */
export function useKortixProjectSessions(
  identity: KortixMasterIdentity,
  projectId: string,
  options: KortixProjectQueryOptions = {},
) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  // `listKortixProjectSessions` itself returns `unknown[]` (its enriched
  // Runtime-session shape isn't schema-typed at the source) — mirror that
  // here rather than lying about the element shape with `any`.
  return useQuery<unknown[]>({
    queryKey: ['kortix', 'projects', projectId, 'sessions', identity.userId ?? 'anonymous', serverUrl],
    queryFn: () => listKortixProjectSessions(serverUrl, projectId),
    enabled: !identity.isLoading && !!identity.userId && !!serverUrl && !!projectId && (options.enabled ?? true),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 2,
    placeholderData: keepPreviousData,
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (id: string) => deleteKortixProject(serverUrl, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: kortixKeys.projects() });
    },
  });
}

export function usePatchProject() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string; user_handle?: string | null }) =>
      patchKortixProject(serverUrl, id, body),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: kortixKeys.project(vars.id) });
      qc.invalidateQueries({ queryKey: kortixKeys.projects() });
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Kortix tasks — /kortix/tasks
// ═════════════════════════════════════════════════════════════════════════

interface KortixTaskQueryOptions {
  enabled?: boolean;
  pollingEnabled?: boolean;
}

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

/** Pure — the daemon's `status` isn't schema-validated, so this normalizes
 * raw rows (defaulting an unrecognized status to `'todo'`) before trusting
 * `KortixTask['status']`. `raw` is genuinely unvalidated wire data — duck-type
 * via `unknown` rather than assume the shape. Exported for direct unit testing. */
export function normalizeTask(raw: unknown): KortixTask {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = VALID_STATUSES.includes(r.status as KortixTaskStatus)
    ? (r.status as KortixTaskStatus)
    : 'todo';
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    title: (r.title as string) || '',
    description: (r.description as string) || '',
    verification_condition: (r.verification_condition as string) || '',
    status,
    result: (r.result as string | null) ?? null,
    verification_summary: (r.verification_summary as string | null) ?? null,
    blocking_question: (r.blocking_question as string | null) ?? null,
    owner_session_id: (r.owner_session_id as string | null) ?? null,
    owner_agent: (r.owner_agent as string | null) ?? null,
    requested_by_session_id: (r.requested_by_session_id as string | null) ?? null,
    started_at: (r.started_at as string | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

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
      if (task?.project_id) {
        qc.invalidateQueries({ queryKey: ['kortix', 'projects', task.project_id] });
        qc.invalidateQueries({ queryKey: ['kortix', 'projects', task.project_id, 'sessions'] });
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

// ═════════════════════════════════════════════════════════════════════════
// Tickets — /kortix/tickets, plus columns/fields/templates/agents/pm-session
// /activity project sub-routes
// ═════════════════════════════════════════════════════════════════════════

export const ticketKeys = {
  tickets: (pid?: string) => ['kortix', 'tickets', pid ?? ''] as const,
  ticket: (id: string) => ['kortix', 'ticket', id] as const,
  events: (id: string) => ['kortix', 'ticket', id, 'events'] as const,
  columns: (pid: string) => ['kortix', 'columns', pid] as const,
  fields: (pid: string) => ['kortix', 'fields', pid] as const,
  templates: (pid: string) => ['kortix', 'templates', pid] as const,
  agents: (pid: string) => ['kortix', 'agents', pid] as const,
};

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

export function useCreateTicket(identity: KortixMasterIdentity) {
  const qc = useQueryClient();
  const handle = identity.handle;
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

export function useUpdateTicket(identity: KortixMasterIdentity) {
  const qc = useQueryClient();
  const handle = identity.handle;
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

export function useUpdateTicketStatus(identity: KortixMasterIdentity) {
  const qc = useQueryClient();
  const handle = identity.handle;
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

export function useAssignTicket(identity: KortixMasterIdentity) {
  const qc = useQueryClient();
  const handle = identity.handle;
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

export function useUnassignTicket(identity: KortixMasterIdentity) {
  const qc = useQueryClient();
  const handle = identity.handle;
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

export function useCommentTicket(identity: KortixMasterIdentity) {
  const qc = useQueryClient();
  const handle = identity.handle;
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
 *
 * Pure — takes `handle` as an explicit parameter rather than reading it from
 * an auth hook. Exported for direct unit testing.
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
 *
 * Pure — same `handle`-as-parameter shape as {@link computeUnread}.
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

// ═════════════════════════════════════════════════════════════════════════
// Milestones — /kortix/projects/:id/milestones
// ═════════════════════════════════════════════════════════════════════════

export const milestoneKeys = {
  list: (pid?: string, status: 'open' | 'closed' | 'all' = 'all') => ['kortix', 'milestones', pid ?? '', status] as const,
  detail: (pid: string, ref: string) => ['kortix', 'milestone', pid, ref] as const,
  events: (pid: string, ref: string) => ['kortix', 'milestone', pid, ref, 'events'] as const,
};

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

// ═════════════════════════════════════════════════════════════════════════
// Sandbox services — /kortix/services
// ═════════════════════════════════════════════════════════════════════════

const getActiveServerUrl = () => {
  return useServerStore.getState().getActiveServerUrl();
};

export const serviceKeys = {
  all: ['sandbox-services'] as const,
  list: (serverUrl: string, includeAll: boolean) =>
    ['sandbox-services', serverUrl, includeAll ? 'all' : 'visible'] as const,
  logs: (serverUrl: string, serviceId: string) =>
    ['sandbox-services', serverUrl, 'logs', serviceId] as const,
  templates: (serverUrl: string) => ['sandbox-services', serverUrl, 'templates'] as const,
};

export function useSandboxServices(identity: KortixMasterIdentity, options?: { enabled?: boolean; includeAll?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  const includeAll = options?.includeAll ?? false;

  return useQuery<SandboxService[]>({
    queryKey: [...serviceKeys.list(serverUrl, includeAll), identity.userId ?? 'anonymous'],
    queryFn: async () => {
      if (!serverUrl) return [];
      return listServices(serverUrl, includeAll);
    },
    enabled: (options?.enabled ?? true) && !identity.isLoading && !!identity.userId && !!serverUrl,
    staleTime: 5_000,
    gcTime: 60_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useSandboxServiceTemplates(identity: KortixMasterIdentity, options?: { enabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<SandboxServiceTemplate[]>({
    queryKey: [...serviceKeys.templates(serverUrl), identity.userId ?? 'anonymous'],
    queryFn: async () => {
      if (!serverUrl) return [];
      return listServiceTemplates(serverUrl);
    },
    enabled: (options?.enabled ?? true) && !identity.isLoading && !!identity.userId && !!serverUrl,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

export function useSandboxServiceLogs(identity: KortixMasterIdentity, serviceId: string | null, options?: { enabled?: boolean }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  return useQuery<string[]>({
    queryKey: serviceId
      ? [...serviceKeys.logs(serverUrl, serviceId), identity.userId ?? 'anonymous']
      : ['sandbox-services', serverUrl, 'logs', 'none', identity.userId ?? 'anonymous'],
    queryFn: async () => {
      if (!serverUrl || !serviceId) return [];
      return getServiceLogs(serverUrl, serviceId);
    },
    enabled: (options?.enabled ?? true) && !identity.isLoading && !!identity.userId && !!serverUrl && !!serviceId,
    staleTime: 3_000,
    gcTime: 60_000,
    refetchInterval: serviceId ? 3_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useSandboxServiceAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ serviceId, action }: { serviceId: string; action: ServiceAction }) => {
      const serverUrl = getActiveServerUrl();
      if (!serverUrl) throw new Error('No active instance selected');
      return sdkServiceAction(serverUrl, serviceId, action);
    },
    onSuccess: () => {
      const serverUrl = getActiveServerUrl();
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
      if (serverUrl) {
        queryClient.invalidateQueries({ queryKey: serviceKeys.templates(serverUrl) });
      }
    },
  });
}

export function useSandboxServiceReconcile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ reload }: { reload?: boolean } = {}) => {
      const serverUrl = getActiveServerUrl();
      if (!serverUrl) throw new Error('No active instance selected');
      return reconcileServices(serverUrl, reload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
  });
}

export function useRegisterSandboxService() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: RegisterSandboxServicePayload) => {
      const serverUrl = getActiveServerUrl();
      if (!serverUrl) throw new Error('No active instance selected');
      return registerService(serverUrl, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serviceKeys.all });
    },
  });
}

// Reload already has a home in the SDK (`systemReload` in `../opencode/client`,
// backing `POST /kortix/services/system/reload`) — reused directly rather
// than duplicated here. It resolves the active runtime URL itself (the same
// zustand state `getActiveServerUrl()` above reads).
export function useSandboxRuntimeReload() {
  return useMutation({
    mutationFn: ({ mode }: { mode: SystemReloadMode }) => systemReload(mode),
  });
}
