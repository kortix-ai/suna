'use client';

/**
 * Shared data + helpers for the PER-SESSION audit / approvals surface.
 *
 * Two views consume this: the side-panel "Audit" tab (session-audit-panel.tsx)
 * and the header nudge (header/session-pending-approvals-indicator.tsx). Both
 * read from ONE react-query key so they dedupe into a single request and stay
 * in lockstep — resolve a pending item in either place and both refresh.
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
import { qk, readSessionAudit, useSessionStreamConnected } from '@kortix/sdk/react';
import { useEffect, useRef } from 'react';
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
  /** Own the one audit poll timer for this session. Cache readers leave this off. */
  poll?: boolean;
  /** Suppress the global error toast (for the always-mounted header nudge). */
  silent?: boolean;
  /**
   * Rows to ask for. Every consumer of THIS hook reads pending approvals, which
   * the server returns most-recent first, so 100 is plenty — the deep timeline
   * moved to `useSessionAuditTimeline`. The query key ignores the limit (all
   * consumers share one cache entry), so the first fetch's limit is the one
   * that runs: a 1000 default here re-imposed the heavy read on every session
   * open even after callers asked for 100.
   */
  limit?: number;
}

export function sessionAuditPollMs(data: Pick<SessionAudit, 'actions'> | undefined): number {
  return data?.actions.some(isPendingAction) ? 5_000 : SESSION_AUDIT_REFETCH_MS;
}

export function useSessionAudit(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: UseSessionAuditOptions,
) {
  const enabled = !!projectId && !!sessionId && (options?.enabled ?? true);
  const queryClient = useQueryClient();
  const key = sessionAuditKey(projectId, sessionId);
  // R5.3: the session stream carries the audit watermark. While it is up, the
  // list is re-read when the watermark moves instead of on a 5-15 s poll.
  const streamConnected = useSessionStreamConnected(projectId ?? '', sessionId ?? '');
  const { data: watermark } = useQuery<unknown>({
    queryKey: qk.project.sessionAuditWatermark(projectId ?? '', sessionId ?? ''),
    queryFn: () => null,
    enabled: false,
  });
  const watermarkKey = watermark === undefined ? null : JSON.stringify(watermark);
  const lastWatermark = useRef<string | null>(null);
  useEffect(() => {
    if (!options?.poll || !enabled || watermarkKey === null) return;
    const previous = lastWatermark.current;
    lastWatermark.current = watermarkKey;
    if (previous !== null && previous !== watermarkKey) {
      void queryClient.invalidateQueries({ queryKey: sessionAuditKey(projectId, sessionId) });
    }
  }, [options?.poll, enabled, watermarkKey, queryClient, projectId, sessionId]);
  return useQuery<SessionAudit>({
    queryKey: key,
    // The session-open bundle (the turn-latency spec (PR #7840) R4) answers this
    // session's FIRST audit read — the same "one round trip to paint" the
    // turn and prompts legs already ride. `readSessionAudit` claims it only
    // when this tab holds no cached rows yet; every read after that (a poll)
    // asks the endpoint directly, for the same staleness reason
    // `readSessionPromptsInbox` documents.
    queryFn: () =>
      readSessionAudit(
        projectId,
        sessionId,
        queryClient.getQueryData<SessionAudit>(key),
        options?.limit ?? 100,
        { showErrors: !options?.silent },
      ),
    enabled,
    staleTime: 10_000,
    refetchOnMount: options?.poll ? true : false,
    refetchInterval:
      options?.poll && !streamConnected ? (query) => sessionAuditPollMs(query.state.data) : false,
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
      note,
    }: {
      executionId: string;
      decision: 'approve' | 'deny';
      /** The approver's message to the agent, delivered with the decision. */
      note?: string;
    }) => {
      if (!projectId) throw new Error('No project in context');
      return resolveApproval(projectId, executionId, decision, { note });
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
