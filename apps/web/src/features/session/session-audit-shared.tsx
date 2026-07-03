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
 * project-wide `listPendingApprovals` (manager-only). That's deliberate: the
 * per-session surface is for the launcher, who may not be a project manager.
 * The resolve endpoint itself allows the manager OR the launcher.
 */

import {
  type SessionAudit,
  type SessionAuditAction,
  getSessionAudit,
  listSessionsNeedingInput,
  resolveApproval,
} from '@kortix/sdk/projects-client';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

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
  const dataList = results.map((r) => r.data);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- merge when any result changes
  return useMemo(() => {
    const sessions: Record<string, number> = {};
    let total = 0;
    for (const d of dataList) {
      if (!d) continue;
      for (const [k, v] of Object.entries(d.sessions)) sessions[k] = v;
      total += d.total ?? 0;
    }
    return { sessions, total };
  }, [JSON.stringify(dataList)]);
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
      getSessionAudit(projectId ?? '', sessionId ?? '', undefined, {
        showErrors: !options?.silent,
      }),
    enabled,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? SESSION_AUDIT_REFETCH_MS,
  });
}

/** Approve/deny mutation that invalidates the shared audit query on settle. */
export function useResolveApproval(projectId: string | undefined, sessionId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      executionId,
      decision,
    }: { executionId: string; decision: 'approve' | 'deny' }) => {
      if (!projectId) throw new Error('No project in context');
      return resolveApproval(projectId, executionId, decision);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionAuditKey(projectId, sessionId) });
    },
  });
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
