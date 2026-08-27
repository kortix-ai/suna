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
  listSessionsNeedingInput,
  resolveApproval,
} from '@kortix/sdk';
import {
  sessionStreamScope,
  useSessionAuditSignal,
  useSessionStreamPresence,
} from '@kortix/sdk/react';
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

/**
 * Per-session pending-approval summary for the sidebar "needs input" badge.
 * Returns `{ sessions: { [sessionId]: count } }` keyed by BOTH the OpenCode and
 * Kortix session ids, so a caller can look up whichever id it holds. Polls
 * quietly (no error toast) since it's an ambient indicator.
 */
export function useSessionsNeedingInput(projectId: string | undefined) {
  return useQuery({
    queryKey: ['sessions-needing-input', projectId ?? ''],
    // `enabled` guards presence, so the `?? ''` fallback is never exercised.
    queryFn: () => listSessionsNeedingInput(projectId ?? '', { showErrors: false }),
    enabled: !!projectId,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

/**
 * Route-independent variant for the sidebar: query needs-input for EACH project
 * the visible sessions belong to (their `projectID`), then merge. Avoids relying
 * on a route projectId — the sidebar renders on routes (e.g. /sessions/:id) where
 * the route param isn't a project. Returns `{ sessions, total }` where `sessions`
 * is keyed by both OpenCode + Kortix session ids.
 */
export function useSessionsNeedingInputForProjects(projectIds: string[]) {
  const results = useQueries({
    queries: projectIds.map((pid) => ({
      queryKey: ['sessions-needing-input', pid],
      queryFn: () => listSessionsNeedingInput(pid, { showErrors: false }),
      enabled: !!pid,
      staleTime: 5_000,
      refetchInterval: 12_000,
    })),
  });
  const sessions: Record<string, number> = {};
  let total = 0;
  for (const result of results) {
    const data = result.data;
    if (!data) continue;
    for (const [key, count] of Object.entries(data.sessions)) sessions[key] = count;
    total += data.total ?? 0;
  }
  return { sessions, total };
}

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

  // The CONTROL channel is the notify path now. The session stream's
  // `kortix.control.audit` frame reports a connector-gated approval appearing or
  // being resolved, so:
  //   - while the stream is connected the 15s poll stands DOWN
  //     (`streamConnected`), exactly like the `/turn` and `/prompts` polls, and
  //   - a real watermark change (`useSessionAuditSignal`) invalidates this
  //     query, so the endpoint is READ once per change instead of on a timer.
  // The endpoint stays the read: the frame carries only the watermark, the rows
  // are still fetched here. With no stream (a client that cannot reach it) the
  // poll resumes — presence is `false`, so nothing is lost.
  const scope = enabled && projectId && sessionId ? sessionStreamScope(projectId, sessionId) : '';
  const streamConnected = useSessionStreamPresence(scope);
  const auditTick = useSessionAuditSignal(projectId ?? '', sessionId ?? '');
  const poll = !!options?.poll;
  // The tick this observer has already accounted for. The FIRST non-zero tick is
  // the stream SEEDING the current watermark, which the mount fetch
  // (`refetchOnMount`) already reads — invalidating on it too fired a second,
  // redundant `GET .../audit` on every open. So the seed is ABSORBED (recorded,
  // not acted on) and only a LATER change — a gated action appearing or being
  // resolved while the session is open — invalidates and re-reads the rows.
  const actedTickRef = useRef<number | null>(null);
  useEffect(() => {
    if (!poll || !enabled) return;
    // `0` is "no watermark seeded yet" — the stream has not delivered a
    // `kortix.control.audit` frame. The mount fetch owns the current state, so
    // wait; recording 0 here would make the seed (0 → 1) look like a change.
    if (auditTick === 0) return;
    if (actedTickRef.current === null) {
      // The SEED — the first watermark, which the mount fetch already read.
      actedTickRef.current = auditTick;
      return;
    }
    if (auditTick === actedTickRef.current) return;
    // A real change AFTER the seed: a gated action appeared or was resolved.
    actedTickRef.current = auditTick;
    void queryClient.invalidateQueries({ queryKey: sessionAuditKey(projectId, sessionId) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditTick, poll, enabled, projectId, sessionId]);

  return useQuery<SessionAudit>({
    queryKey: sessionAuditKey(projectId, sessionId),
    // `enabled` guards presence, so the `?? ''` fallbacks are never exercised.
    // KEPT (never deleted) so a reader always has a queryFn: folding the poll
    // moved the NOTIFY onto the stream, not the READ — the invalidate above and
    // a with-no-stream poll both drive this same fetch.
    queryFn: () =>
      getSessionAudit(projectId ?? '', sessionId ?? '', options?.limit ?? 100, {
        showErrors: !options?.silent,
        includeEvents: false,
      }),
    enabled,
    staleTime: 10_000,
    refetchOnMount: poll ? true : false,
    // The timer runs ONLY when the stream is not delivering. Connected, the
    // control-channel invalidate above is the whole liveness path.
    refetchInterval:
      poll && !streamConnected ? (query) => sessionAuditPollMs(query.state.data) : false,
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
