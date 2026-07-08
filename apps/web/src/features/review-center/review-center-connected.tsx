'use client';

/**
 * Review Center wired to live data: fetches the project's review items, maps the
 * API rows into the inbox view model, and routes the inbox's actions to the right
 * backend flow. Native items go through the `/act` and `/bulk` mutations; adapted
 * items act through THEIR OWN source flow — a Change Request ships via merge,
 * is dismissed via close, and "request changes" persists the feedback + delivers
 * it to the change's agent (the review `/act` endpoint 409s on adapted ids by
 * design). Executor approvals (`exec:`) resolve directly via `resolveApproval` —
 * the same client call the in-session approval prompt uses
 * (session-approval-prompt.tsx) — so Approve/Deny work inline in the inbox too.
 * The presentational inbox (review-center.tsx) is shared with the mock
 * prototype. See docs/REVIEW_CENTER_DESIGN.md.
 */

import { errorToast, infoToast, successToast } from '@/components/ui/toast';
import { useProjectContext } from '@/features/project-files/context';
import {
  useCloseChangeRequest,
  useMergeChangeRequest,
  useRequestChangesOnChangeRequest,
} from '@/features/project-files/hooks/use-change-requests';
import { useCustomizeStore } from '@/stores/customize-store';
import { type ReviewVerdict, listProjectSessions } from '@kortix/sdk/projects-client';
import { clearStartStash } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import {
  useActReviewItem,
  useBulkActReviewItems,
  useResolveReviewApproval,
  useReviewItems,
} from './hooks/use-review-items';
import { mapApiReviewItem } from './map';
import { crChangeRequestId, execExecutionId, itemDeepLink, planBulkAction } from './review-actions';
import { ReviewCenter } from './review-center';
import { isSafeRisk } from './types';

export function ReviewCenterConnected({ projectName }: { projectName: string }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const qc = useQueryClient();
  const router = useRouter();
  const closeCustomize = useCustomizeStore((s) => s.close);
  const { data, isLoading, isFetching, isError, refetch } = useReviewItems();
  const act = useActReviewItem();
  const bulk = useBulkActReviewItems();
  const resolve = useResolveReviewApproval();
  const merge = useMergeChangeRequest();
  const close = useCloseChangeRequest();
  const requestChanges = useRequestChangesOnChangeRequest();

  // Session names for the per-session filter + group headers (sessionId → label).
  // Also names the originating session in each approval's description.
  const { data: sessions } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  const sessionLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of sessions ?? []) {
      if (s.name) m[s.session_id] = s.name;
    }
    return m;
  }, [sessions]);

  const items = useMemo(
    () =>
      (data?.review_items ?? []).map((row) => mapApiReviewItem(row, projectName, sessionLabels)),
    [data, projectName, sessionLabels],
  );

  const refreshInbox = () => qc.invalidateQueries({ queryKey: ['review-center', projectId] });

  function handleAct(id: string, verdict: ReviewVerdict, feedback?: string) {
    // Executor approvals resolve directly — the same call + payload the
    // in-session approval prompt uses (resolveApproval, 'once' scope: this
    // acts on the one call the row represents, not "for the rest of the
    // session" — that broader grant stays a session-view affordance).
    const executionId = execExecutionId(id);
    if (executionId) {
      resolve.mutate(
        { executionId, decision: verdict === 'approve' ? 'approve' : 'deny' },
        {
          onSuccess: () =>
            verdict === 'approve'
              ? successToast('Approved — the agent will continue')
              : infoToast('Denied'),
          onError: (e) => errorToast(e.message),
        },
      );
      return;
    }
    // Change Requests ship/close through their own flow — the review `/act`
    // endpoint 409s on `cr:` ids ("act on this item from its source view").
    const crId = crChangeRequestId(id);
    if (crId) {
      if (verdict === 'approve') {
        merge.mutate(crId, {
          onSuccess: () => {
            successToast('Change shipped — merged into the base branch');
            refreshInbox();
          },
          onError: (e) => errorToast(e.message),
        });
      } else if (verdict === 'reject') {
        close.mutate(crId, {
          onSuccess: () => {
            infoToast('Change closed');
            refreshInbox();
          },
          onError: (e) => errorToast(e.message),
        });
      } else {
        // "Request changes" → persist the note on the change AND deliver it to the
        // agent that opened it (backend boots the sandbox + sends the prompt). No
        // navigation; the item moves to Waiting once the note lands.
        const note = (feedback ?? '').trim();
        if (!note) {
          infoToast('Add a note describing what to change, then send.');
          return;
        }
        requestChanges.mutate(
          { crId, feedback: note },
          {
            onSuccess: (res) => {
              successToast(
                res.delivering
                  ? "Sent to the agent — it'll revise the change."
                  : 'Saved on the change.',
              );
              refreshInbox();
            },
            onError: (e) => errorToast(e.message),
          },
        );
      }
      return;
    }
    act.mutate({ id, verdict, feedback }, { onError: (e) => errorToast(e.message) });
  }

  // Bulk (multi-select) verdicts: the presentational layer pre-filters the
  // selection through `resolveBulkOutcome` (same pure helper), so what
  // arrives here is already actionable — native ids for any verdict, exec
  // approvals only under an APPROVE that passed the safe-risk floor. The
  // guards below are defense in depth, not the primary filter:
  //  - an executor approval is a live question to the agent; a bulk
  //    "dismiss" must NEVER answer it with a deny, so exec ids resolve only
  //    on an explicit approve (single-item Deny goes through handleAct).
  //  - the safe-risk floor is re-checked before each resolve.
  //  - Change Requests have no bulk path (merging needs the diff in view).
  function handleBulkAct(ids: string[], verdict: ReviewVerdict) {
    const { native, resolvable, unsupported } = planBulkAction(ids);
    if (native.length > 0) {
      bulk.mutate({ ids: native, verdict }, { onError: (e) => errorToast(e.message) });
    }
    if (resolvable.length > 0 && verdict === 'approve') {
      const riskById = new Map(items.map((i) => [i.id, i.risk]));
      for (const id of resolvable) {
        if (!isSafeRisk(riskById.get(id) ?? 'high')) continue;
        const executionId = execExecutionId(id);
        if (executionId)
          resolve.mutate(
            { executionId, decision: 'approve' },
            { onError: (e) => errorToast(e.message) },
          );
      }
    }
    if (unsupported.length > 0) {
      infoToast(
        `${unsupported.length} ${unsupported.length === 1 ? 'change needs' : 'changes need'} its own review — open ${unsupported.length === 1 ? 'it' : 'them'} to ship.`,
      );
    }
  }

  return (
    <ReviewCenter
      initialItems={items}
      isLoading={isLoading}
      isFetching={isFetching}
      isError={isError}
      sessionLabels={sessionLabels}
      onAct={handleAct}
      onBulkAct={handleBulkAct}
      onRefresh={() => void refetch()}
      onOpenSession={(sessionId) => {
        // "See progress" only VIEWS the session — feedback delivery goes through
        // the backend now. Clear any stale queued prompt so navigating can't
        // auto-send a leftover message (e.g. from an earlier client-side attempt).
        const href = itemDeepLink(projectId, sessionId);
        if (!href) return;
        clearStartStash(sessionId);
        closeCustomize();
        router.push(href);
      }}
    />
  );
}
