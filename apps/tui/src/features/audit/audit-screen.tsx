/**
 * The Audit screen: the open session's audit trail and pending approvals
 * (SPEC §5).
 *
 * This file is the data half. The SDK has no React hook for the audit read
 * (the web keeps `useSessionAudit` app-local), so the two reads are TanStack
 * queries over the `kortix().session(p, s).audit(...)` client method — the
 * same call and the same options the web panel's hooks make:
 *   - approvals: `includeEvents: false`, polled while an action is pending;
 *   - timeline: `includeEvents: true`, 200 per page, `cursor` for older events.
 * Approve and deny are `kortix().project(p).approvals.resolve`.
 *
 * No feature flag. Without the Enterprise `auditAccess` entitlement the API
 * answers pending approvals only (`audit_access: false`); the screen says so.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { theme } from '../../theme.ts';
import { AuditView } from './audit-view.tsx';
import { buildRows, isPendingAction, type AuditRow } from './rows.ts';

export interface AuditScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  /** Inner columns. */
  width: number;
  /** Inner rows. */
  height: number;
  /** Kortix web origin. Carried for the caller; Audit has no browser action. */
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
}

/** Poll period for the approvals read while an action waits for a decision. */
export const PENDING_POLL_MS = 5_000;
/** Poll period when nothing is pending. */
export const IDLE_POLL_MS = 15_000;
const TIMELINE_PAGE = 200;
const APPROVALS_LIMIT = 100;
const CLOCK_TICK_MS = 30_000;

export const NO_HISTORY_NOTICE =
  'History needs the Enterprise audit entitlement. Showing pending approvals only.';

function errorText(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'Unknown error';
  return typeof status === 'number' ? `HTTP ${status}: ${message}` : message;
}

export function AuditScreen({
  projectId,
  accountId: _accountId,
  sessionId,
  focused,
  width,
  height,
  webBaseUrl: _webBaseUrl,
  onBack,
  onOpenSession: _onOpenSession,
  onToast,
}: AuditScreenProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const ready = Boolean(projectId && sessionId);

  const approvals = useQuery({
    queryKey: ['tui-session-audit-approvals', projectId, sessionId],
    queryFn: () =>
      kortix()
        .session(projectId as string, sessionId as string)
        .audit(APPROVALS_LIMIT, { includeEvents: false, showErrors: false }),
    enabled: ready,
    refetchInterval: (query) =>
      query.state.data?.actions.some(isPendingAction) ? PENDING_POLL_MS : IDLE_POLL_MS,
  });
  const entitled = approvals.data ? approvals.data.audit_access !== false : false;

  const timeline = useInfiniteQuery({
    queryKey: ['tui-session-audit-timeline', projectId, sessionId],
    queryFn: ({ pageParam }) =>
      kortix()
        .session(projectId as string, sessionId as string)
        .audit(TIMELINE_PAGE, {
          cursor: typeof pageParam === 'string' ? pageParam : undefined,
          includeEvents: true,
          showErrors: false,
        }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: ready && entitled,
  });

  const rows = useMemo(
    () =>
      buildRows(
        approvals.data?.actions ?? [],
        (timeline.data?.pages ?? []).flatMap((page) => page.events ?? []),
      ),
    [approvals.data, timeline.data],
  );

  const decide = useCallback(
    (row: AuditRow, decision: 'approve' | 'deny') => {
      if (!projectId || !row.pending) return;
      setBusy(decision === 'approve' ? 'approving…' : 'denying…');
      void kortix()
        .project(projectId)
        .approvals.resolve(row.pending.executionId, decision)
        .then(async () => {
          onToast(decision === 'approve' ? 'Action approved.' : 'Action denied.');
          await Promise.all([approvals.refetch(), timeline.refetch()]);
        })
        .catch((error: unknown) => onToast(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [projectId, approvals.refetch, timeline.refetch, onToast],
  );

  const refresh = useCallback(() => {
    setBusy('refreshing…');
    void Promise.all([approvals.refetch(), entitled ? timeline.refetch() : null])
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [approvals.refetch, timeline.refetch, entitled, onToast]);

  const loadMore = useCallback(() => {
    if (timeline.isFetchingNextPage) return;
    void timeline.fetchNextPage().catch((error: unknown) => onToast(errorText(error), 'error'));
  }, [timeline.fetchNextPage, timeline.isFetchingNextPage, onToast]);

  if (!projectId) return <text fg={theme.faint}>No project selected.</text>;
  if (!sessionId) return <text fg={theme.faint}>Open a session first.</text>;

  const error = approvals.error ?? timeline.error;
  return (
    <AuditView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={approvals.isLoading || (entitled && timeline.isLoading)}
      errorMessage={error ? errorText(error) : null}
      busyMessage={timeline.isFetchingNextPage ? 'loading older events…' : busy}
      notice={approvals.data && !entitled ? NO_HISTORY_NOTICE : null}
      hasMore={timeline.hasNextPage}
      onDecide={decide}
      onLoadMore={loadMore}
      onRefresh={refresh}
      onBack={onBack}
    />
  );
}
