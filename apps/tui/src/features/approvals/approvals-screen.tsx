/**
 * The Approvals screen: the Review Center (approvals, outputs, decisions, and
 * change requests that wait on a person).
 *
 * This file is the data half. Reads are `@kortix/sdk/react` hooks; every
 * verdict is one `kortix().project(id)` call, routed the way the web routes it
 * (`review-center-connected.tsx` `handleAct`):
 *
 * - `call:<id>` connector approval -> `approvals.resolve` (approve or deny).
 * - `cr:<id>` change request -> `changeRequests.merge` (approve),
 *   `.close` (reject), `.requestChanges` (changes). The review `/act` route
 *   answers 409 for an adapted id by design.
 * - any other id -> `review.act` with the verdict and the text as `feedback`.
 *
 * It renders `<ApprovalsView/>`, which knows nothing about the SDK. No flag
 * gates the Review Center.
 */

import { mapApiReviewItem, reviewItemTarget } from '@kortix/sdk';
import type { ApiReviewItem, ReviewItem, ReviewSegment } from '@kortix/sdk';
import { qk, reviewItemsOf, useReviewItemPages, useReviewSummary } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import {
  VERB_LABEL,
  type Verb,
  groupRows,
  toApprovalRow,
  webReviewUrl,
} from './approvals-model.ts';
import { type ApprovalDetail, ApprovalsView } from './approvals-view.tsx';

export interface ApprovalsScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
}

/** The web polls the open list every 8 s. */
const LIST_POLL_MS = 8_000;
/** How often the age column is recomputed. */
const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

/** The toast after a verdict, past tense. */
export function doneText(verb: Verb, id: string): string {
  const target = reviewItemTarget(id);
  const merges = target.type === 'change_request';
  switch (verb) {
    case 'approve':
      return merges ? 'Change merged.' : 'Approved.';
    case 'reject':
      return merges ? 'Change closed.' : target.type === 'connector_call' ? 'Denied.' : 'Rejected.';
    case 'changes':
      return 'Changes requested.';
    case 'dismiss':
      return 'Dismissed.';
    case 'answer':
      return 'Answer sent.';
  }
}

export function ApprovalsScreen({
  projectId,
  accountId: _accountId,
  sessionId: _sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession,
  onToast,
}: ApprovalsScreenProps) {
  const client = useQueryClient();
  const [segment, setSegment] = useState<ReviewSegment>('needs_you');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const pid = projectId ?? '';
  // Each segment is its own paged server read (KRTX-2316).
  const pages = useReviewItemPages(pid, { segment }, { refetchInterval: LIST_POLL_MS });
  const summary = useReviewSummary(pid);
  const apiRows = useMemo<ApiReviewItem[]>(() => reviewItemsOf(pages.data), [pages.data]);
  const items = useMemo<ReviewItem[]>(() => apiRows.map((row) => mapApiReviewItem(row)), [apiRows]);
  const rows = useMemo(() => groupRows(items.map(toApprovalRow)), [items]);

  // An opened connector call is read by id once: that read loads its content
  // (the draft, the pull request). An item past the loaded pages, or one a
  // verdict just moved to another list, is read by id too.
  const listed = items.find((item) => item.id === detailId) ?? null;
  const isCall = detailId !== null && reviewItemTarget(detailId).type === 'connector_call';
  const byId = useQuery({
    queryKey: [...qk.project.reviewItemsScope(pid), 'item', detailId ?? ''],
    queryFn: async () =>
      (
        await kortix()
          .project(pid)
          .review.get(detailId as string)
      ).review_item,
    enabled: Boolean(pid) && detailId !== null && (isCall || listed === null),
    staleTime: 5_000,
    retry: false,
  });
  const detail = useMemo<ApprovalDetail | null>(() => {
    if (detailId === null) return null;
    const fresh = byId.data ? mapApiReviewItem(byId.data) : null;
    if (listed) {
      // Only the detail comes from the by-id read; the status stays the list's.
      const item = fresh && isCall ? ({ ...listed, detail: fresh.detail } as ReviewItem) : listed;
      return { item, loading: isCall && byId.isLoading };
    }
    return fresh ? { item: fresh, loading: false } : null;
  }, [detailId, listed, byId.data, byId.isLoading, isCall]);

  const refreshInbox = useCallback(async () => {
    if (!pid) return;
    await Promise.all([
      client.invalidateQueries({ queryKey: qk.project.reviewItemsScope(pid) }),
      client.invalidateQueries({ queryKey: qk.project.reviewSummary(pid) }),
      client.invalidateQueries({ queryKey: qk.project.needsInput(pid) }),
    ]);
  }, [client, pid]);

  const act = useCallback(
    (id: string, verb: Verb, text: string) => {
      if (!projectId) return;
      const project = kortix().project(projectId);
      const target = reviewItemTarget(id);
      const note = text.trim();
      setBusy(`${VERB_LABEL[verb].toLowerCase()}…`);
      void (async () => {
        if (target.type === 'connector_call') {
          await project.approvals.resolve(
            target.executionId,
            verb === 'approve' ? 'approve' : 'deny',
            note ? { note } : {},
          );
        } else if (target.type === 'change_request') {
          if (verb === 'approve') await project.changeRequests.merge(target.changeRequestId);
          else if (verb === 'reject') await project.changeRequests.close(target.changeRequestId);
          else await project.changeRequests.requestChanges(target.changeRequestId, note);
        } else {
          await project.review.act(id, { verdict: verb, ...(note ? { feedback: note } : {}) });
        }
        await refreshInbox();
        onToast(doneText(verb, id));
      })()
        .catch((error: unknown) => {
          const code = (error as { code?: string }).code;
          onToast(
            code === 'MERGE_CONFLICT'
              ? 'Merge conflict. Resolve it in Review or the web app.'
              : errorText(error),
            'error',
          );
          void refreshInbox();
        })
        .finally(() => setBusy(null));
    },
    [projectId, refreshInbox, onToast],
  );

  const openWeb = useCallback(
    (id: string) => {
      if (!projectId) return;
      void openUrl(webReviewUrl(webBaseUrl, projectId, id))
        .then(() => onToast('Opened in the browser.'))
        .catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [projectId, webBaseUrl, onToast],
  );

  const refresh = useCallback(() => {
    setBusy('refreshing…');
    void Promise.all([pages.refetch(), summary.refetch()])
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [pages.refetch, summary.refetch, onToast]);

  const loadMore = useCallback(() => {
    if (pages.hasNextPage && !pages.isFetchingNextPage) void pages.fetchNextPage();
  }, [pages.hasNextPage, pages.isFetchingNextPage, pages.fetchNextPage]);

  if (!projectId) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>No project selected.</text>
      </box>
    );
  }

  return (
    <ApprovalsView
      rows={rows}
      segment={segment}
      needsYouCount={summary.data?.needs_you_total ?? null}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={pages.isLoading}
      errorMessage={pages.isError ? errorText(pages.error) : null}
      busyMessage={busy}
      hasMore={Boolean(pages.hasNextPage)}
      detail={detail}
      onSegmentChange={setSegment}
      onOpenDetails={setDetailId}
      onAct={act}
      onOpenSession={onOpenSession}
      onOpenWeb={openWeb}
      onLoadMore={loadMore}
      onRefresh={refresh}
      onBack={onBack}
    />
  );
}
