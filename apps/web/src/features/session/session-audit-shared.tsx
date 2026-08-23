'use client';

/**
 * Shared data + helpers for the PER-SESSION audit / approvals surface.
 *
 * Consumers include the side-panel "Audit" tab (session-audit-panel.tsx), the
 * header nudge (header/session-pending-approvals-indicator.tsx), and the inline
 * approval prompt (session-approval-prompt.tsx). All pending-approval readers
 * share ONE react-query key (`sessionAuditKey`) so they dedupe into a single
 * request and stay in lockstep — resolve a pending item in any of them and
 * every surface refreshes.
 *
 * Gating note: we drive everything off `getSessionAudit` (gated on session
 * VISIBILITY — the launcher can see their own session) rather than the
 * project-wide `listPendingApprovals` (account owner/admin only). That's
 * deliberate: the per-session surface is for the launcher, who may not be an
 * account owner/admin. The resolve endpoint itself allows an account
 * owner/admin OR the launcher.
 */

import {
  type SessionAudit,
  type SessionAuditAction,
  getSessionAudit,
  resolveApproval,
} from '@kortix/sdk';
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

/** One poll cadence for the shared session-audit query, so both surfaces (panel
 *  + header nudge) agree regardless of which mounts first. Pauses in background
 *  tabs (react-query's refetchIntervalInBackground defaults to false). */
export const SESSION_AUDIT_REFETCH_MS = 15_000;

export function sessionAuditKey(projectId: string | undefined, sessionId: string | undefined) {
  return ['session-audit', projectId ?? '', sessionId ?? ''] as const;
}

/** A gated action still awaiting a human decision (unresolved `pending_approval`). */
export function isPendingAction(a: SessionAuditAction): boolean {
  return a.status === 'pending_approval' && !a.resolved_at;
}

interface UseSessionAuditOptions {
  /** Skip the query entirely (e.g. not the active session / missing ids). */
  enabled?: boolean;
  /** Poll cadence in ms — pending items resolve out-of-band. Default 20s. */
  refetchInterval?: number | false;
  /** Suppress the global error toast (for the always-mounted header nudge). */
  silent?: boolean;
}

export function useSessionAudit(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: UseSessionAuditOptions,
) {
  const enabled = !!projectId && !!sessionId && (options?.enabled ?? true);
  return useQuery<SessionAudit>({
    queryKey: sessionAuditKey(projectId, sessionId),
    // `enabled` guards presence, so the `?? ''` fallbacks are never exercised.
    queryFn: () =>
      getSessionAudit(projectId ?? '', sessionId ?? '', 1000, {
        showErrors: !options?.silent,
        includeEvents: false,
      }),
    enabled,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? SESSION_AUDIT_REFETCH_MS,
  });
}

/**
 * Paginated canonical session timeline.
 *
 * This query does not poll. Pending approvals use `useSessionAudit`, whose
 * lightweight request excludes historical events. Loading more history never
 * makes the 15-second approval poll refetch pages the user already read.
 */
export function useSessionAuditTimeline(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: Pick<UseSessionAuditOptions, 'enabled' | 'silent'>,
) {
  const enabled = !!projectId && !!sessionId && (options?.enabled ?? true);
  return useInfiniteQuery({
    queryKey: ['session-audit-timeline', projectId ?? '', sessionId ?? ''] as const,
    queryFn: ({ pageParam }) =>
      getSessionAudit(projectId ?? '', sessionId ?? '', 200, {
        cursor: typeof pageParam === 'string' ? pageParam : undefined,
        includeEvents: true,
        showErrors: !options?.silent,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled,
    staleTime: 10_000,
  });
}

/**
 * Mutation options for approve/deny, extracted out of `useResolveApproval` so
 * this is directly testable without rendering a component (see
 * `session-audit-shared.test.ts`).
 *
 * Every call site (`SessionApprovalPrompt`, `SessionAuditPanel`,
 * `SessionPendingApprovalsIndicator`) passes its own call-time `onError` to
 * `resolve.mutate(vars, { onError })` and shows a specific, actionable toast
 * (e.g. "Failed to resolve approval"). Without a hook-level `onError` here,
 * TanStack Query's `defaultMutationOptions()` merge falls back to the
 * QueryClient's global default mutation `onError`
 * (`apps/web/src/app/react-query-provider.tsx`) — which ALSO fires, in
 * addition to (not instead of) the call-time one. That produced a confusing
 * SECOND toast — the generic "Failed to perform action: <message>" — anytime
 * a resolve failed, most visibly when the target execution had already been
 * resolved elsewhere (the resolve endpoint can be hit with zero browsers
 * open, and the audit poll can lag a few seconds behind), which 404s with a
 * bare "not found". The no-op `onError` below opts this mutation out of the
 * global default, matching the same pattern already used by
 * `useAbortRuntimeSession` — every consumer already owns its own error UX.
 */
export function resolveApprovalMutationOptions(
  projectId: string | undefined,
  sessionId: string | undefined,
  queryClient: QueryClient,
) {
  return {
    // No `scope`: a decision applies to exactly the call that asked for it.
    // 'session' / 'session_all' were removed — a one-click "stop asking"
    // pre-authorised later calls with different arguments, defeating the gate.
    mutationFn: ({
      executionId,
      decision,
    }: {
      executionId: string;
      decision: 'approve' | 'deny';
    }) => {
      if (!projectId) throw new Error('No project in context');
      return resolveApproval(projectId, executionId, decision);
    },
    // See the jsdoc above `useResolveApproval` — opts out of the global
    // default mutation `onError` so it doesn't double-toast alongside each
    // call site's own, more specific error handling.
    onError: () => {},
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionAuditKey(projectId, sessionId) });
    },
  };
}

/** Approve/deny mutation that invalidates the shared audit query on settle —
 *  see `resolveApprovalMutationOptions` above for why it opts out of the
 *  global default mutation `onError`. */
export function useResolveApproval(projectId: string | undefined, sessionId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation(resolveApprovalMutationOptions(projectId, sessionId, queryClient));
}

export function riskTone(risk: string | null): 'destructive' | 'warning' | 'muted' {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'write') return 'warning';
  return 'muted';
}

/** Terminal outcome of a gated action → badge tone. */
export function statusTone(status: string): 'success' | 'destructive' | 'warning' | 'muted' {
  if (status === 'ok') return 'success';
  if (status === 'denied' || status === 'error') return 'destructive';
  if (status === 'pending_approval') return 'warning';
  return 'muted';
}

/** Human label for a status value. */
export function statusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return 'Allowed';
    case 'denied':
      return 'Denied';
    case 'error':
      return 'Error';
    case 'pending_approval':
      return 'Pending';
    default:
      return status;
  }
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
