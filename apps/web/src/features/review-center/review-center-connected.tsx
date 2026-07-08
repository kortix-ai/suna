'use client';

/**
 * Review Center wired to live data: fetches the project's review items, maps the
 * API rows into the inbox view model, and routes the inbox's actions to the right
 * backend flow. Native items go through the `/act` and `/bulk` mutations; adapted
 * items act through THEIR OWN source flow — a Change Request ships via merge,
 * is dismissed via close, and "request changes" persists the feedback + delivers
 * it to the change's agent (the review `/act` endpoint 409s on adapted ids by
 * design). The presentational inbox (review-center.tsx) is shared with the mock
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
import { useActReviewItem, useBulkActReviewItems, useReviewItems } from './hooks/use-review-items';
import { mapApiReviewItem } from './map';
import { ReviewCenter } from './review-center';

const CR_PREFIX = 'cr:';
const EXEC_PREFIX = 'exec:';

export function ReviewCenterConnected({
  projectName,
  canAct = true,
}: {
  projectName: string;
  // When false (a review.read-only role), withhold the act handlers so the
  // ReviewCenter renders its inbox read-only — no mutation UI that would 403.
  // Defaults to true to preserve behavior for callers that don't gate.
  canAct?: boolean;
}) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const qc = useQueryClient();
  const router = useRouter();
  const closeCustomize = useCustomizeStore((s) => s.close);
  const { data, isLoading, isFetching } = useReviewItems();
  const act = useActReviewItem();
  const bulk = useBulkActReviewItems();
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
    // Change Requests ship/close through their own flow — the review `/act`
    // endpoint 409s on `cr:` ids ("act on this item from its source view").
    if (id.startsWith(CR_PREFIX)) {
      const crId = id.slice(CR_PREFIX.length);
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
    // Executor approvals resume through the connector flow (KORTIX-207); not yet
    // actionable from the inbox, so guide rather than throw a 409.
    if (id.startsWith(EXEC_PREFIX)) {
      infoToast('Approve tool actions from the connector’s policy view for now.');
      return;
    }
    act.mutate({ id, verdict, feedback }, { onError: (e) => errorToast(e.message) });
  }

  return (
    <ReviewCenter
      initialItems={items}
      isLoading={isLoading}
      isFetching={isFetching}
      sessionLabels={sessionLabels}
      onAct={canAct ? handleAct : undefined}
      onBulkAct={
        canAct
          ? (ids, verdict) =>
              bulk.mutate({ ids, verdict }, { onError: (e) => errorToast(e.message) })
          : undefined
      }
      onOpenSession={(sessionId) => {
        // "See progress" only VIEWS the session — feedback delivery goes through
        // the backend now. Clear any stale queued prompt so navigating can't
        // auto-send a leftover message (e.g. from an earlier client-side attempt).
        clearStartStash(sessionId);
        closeCustomize();
        router.push(`/projects/${projectId}/sessions/${sessionId}`);
      }}
    />
  );
}
