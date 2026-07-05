'use client';

/**
 * Kortix tickets — hooks for tickets, columns, fields, templates, and
 * workspace agents (the "team"). Hits /kortix/tickets and legacy
 * /kortix/projects/:id/* compatibility routes.
 *
 * Thin wrapper over `@kortix/sdk/react` (`use-kortix-master.ts`): the
 * react-query layer, query keys, and pure notification/parsing helpers live
 * in the SDK now. The one thing that stays here is `useUserHandle` (and the
 * `useAuth()` + `getUserHandle()` call it makes) — that IS the web-specific
 * identity source, injected into the SDK's ticket-mutation hooks via the
 * `KortixMasterIdentity` seam.
 */

import { useAuth } from '@/features/providers/auth-provider';
import { getUserHandle } from '@/lib/kortix/user-handle';
import {
  ticketKeys,
  useTickets,
  useTicket,
  useTicketEvents,
  useCreateTicket as useCreateTicketSdk,
  useUpdateTicket as useUpdateTicketSdk,
  useUpdateTicketStatus as useUpdateTicketStatusSdk,
  useAssignTicket as useAssignTicketSdk,
  useUnassignTicket as useUnassignTicketSdk,
  useCommentTicket as useCommentTicketSdk,
  useDeleteTicket,
  useColumns,
  useReplaceColumns,
  useFields,
  useReplaceFields,
  useTemplates,
  useReplaceTemplates,
  useEnsurePmSession,
  useProjectAgents,
  useCreateProjectAgent,
  useUpdateProjectAgent,
  useDeleteProjectAgent,
  useAgentPersona,
  useProjectActivity,
  computeUnread,
  computeNotifications,
  readLastSeen,
  writeLastSeen,
  LAST_SEEN_EVENT,
  safeParseJsonArray,
  parseCustomFields,
  type KortixMasterIdentity,
  type AssigneeType,
  type ActorType,
  type ExecutionMode,
  type ToolGroup,
  type TicketAssignee,
  type TicketColumn,
  type Ticket,
  type TicketEvent,
  type ProjectField,
  type TicketTemplate,
  type ProjectAgent,
  type UnreadComputation,
  type NotificationKind,
  type ProjectNotification,
} from '@kortix/sdk/react';

// ── Types ────────────────────────────────────────────────────────────────────
// The request/response shapes live in the SDK now (`@kortix/sdk/react`);
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
  UnreadComputation,
  NotificationKind,
  ProjectNotification,
};

export {
  ticketKeys,
  useTickets,
  useTicket,
  useTicketEvents,
  useDeleteTicket,
  useColumns,
  useReplaceColumns,
  useFields,
  useReplaceFields,
  useTemplates,
  useReplaceTemplates,
  useEnsurePmSession,
  useProjectAgents,
  useCreateProjectAgent,
  useUpdateProjectAgent,
  useDeleteProjectAgent,
  useAgentPersona,
  useProjectActivity,
  computeUnread,
  computeNotifications,
  readLastSeen,
  writeLastSeen,
  LAST_SEEN_EVENT,
  safeParseJsonArray,
  parseCustomFields,
};

// ── User identity ────────────────────────────────────────────────────────────
// This is the actual identity source for the whole module — every mutation
// below derives its `KortixMasterIdentity` from it.

export function useUserHandle(): string {
  const { user } = useAuth();
  return getUserHandle(user);
}

function useTicketIdentity(): KortixMasterIdentity {
  const { user, isLoading } = useAuth();
  return { userId: user?.id ?? null, handle: getUserHandle(user), isLoading };
}

// ── Tickets (mutations needing actor identity) ───────────────────────────────

export function useCreateTicket() {
  const identity = useTicketIdentity();
  return useCreateTicketSdk(identity);
}

export function useUpdateTicket() {
  const identity = useTicketIdentity();
  return useUpdateTicketSdk(identity);
}

export function useUpdateTicketStatus() {
  const identity = useTicketIdentity();
  return useUpdateTicketStatusSdk(identity);
}

export function useAssignTicket() {
  const identity = useTicketIdentity();
  return useAssignTicketSdk(identity);
}

export function useUnassignTicket() {
  const identity = useTicketIdentity();
  return useUnassignTicketSdk(identity);
}

export function useCommentTicket() {
  const identity = useTicketIdentity();
  return useCommentTicketSdk(identity);
}
