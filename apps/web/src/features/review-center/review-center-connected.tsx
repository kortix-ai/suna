'use client';

/**
 * Review Center wired to live data: fetches the project's review items, maps the
 * API rows into the inbox view model, and routes the inbox's actions to the right
 * backend flow. Native items go through the `/act` and `/bulk` mutations; adapted
 * items act through THEIR OWN source flow — a Change Request ships via merge and
 * is dismissed via close (the `/act` endpoint returns 409 for adapted ids by
 * design). The presentational inbox (review-center.tsx) is shared with the mock
 * prototype. See docs/REVIEW_CENTER_DESIGN.md.
 */

import { errorToast, infoToast, successToast } from '@/components/ui/toast';
import { useProjectContext } from '@/features/project-files/context';
import {
  useCloseChangeRequest,
  useMergeChangeRequest,
} from '@/features/project-files/hooks/use-change-requests';
import type { ReviewVerdict } from '@/lib/projects-client';
import { useCustomizeStore } from '@/stores/customize-store';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { useActReviewItem, useBulkActReviewItems, useReviewItems } from './hooks/use-review-items';
import { mapApiReviewItem } from './map';
import { ReviewCenter } from './review-center';

const CR_PREFIX = 'cr:';
const EXEC_PREFIX = 'exec:';

/** Queue a message to AUTO-SEND to a project session once it opens — the same
 *  hand-off the project-home composer uses: stash under the project-session key,
 *  navigate, and the session page migrates it onto the live OpenCode session and
 *  sends it (so the agent picks it up without the user re-typing). */
function queueSessionPrompt(sessionId: string, text: string) {
  try {
    sessionStorage.setItem(`project_pending_prompt:${sessionId}`, text);
  } catch {
    // sessionStorage unavailable (SSR / privacy mode) — navigation still lands
    // the user in the session, where they can send it manually.
  }
}

export function ReviewCenterConnected({ projectName }: { projectName: string }) {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const qc = useQueryClient();
  const router = useRouter();
  const closeCustomize = useCustomizeStore((s) => s.close);
  const { data, isLoading } = useReviewItems();
  const act = useActReviewItem();
  const bulk = useBulkActReviewItems();
  const merge = useMergeChangeRequest();
  const close = useCloseChangeRequest();

  const items = useMemo(
    () => (data?.review_items ?? []).map((row) => mapApiReviewItem(row, projectName)),
    [data, projectName],
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
        // "Request changes" → deliver the feedback to the agent that opened the
        // change: seed its session composer and jump into the conversation, so
        // the user sends it (and the agent revises) in context.
        const target = items.find((i) => i.id === id);
        if (target?.sessionId && projectId) {
          const note = (feedback ?? '').trim();
          const message = note
            ? `Please revise the change "${target.title}":\n\n${note}`
            : `Please revise the change "${target.title}".`;
          queueSessionPrompt(target.sessionId, message);
          closeCustomize();
          infoToast('Sending your request to the agent…');
          router.push(`/projects/${projectId}/sessions/${target.sessionId}`);
        } else {
          infoToast('This change has no linked session — open it from Changes to act on it.');
        }
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
      onAct={handleAct}
      onBulkAct={(ids, verdict) =>
        bulk.mutate({ ids, verdict }, { onError: (e) => errorToast(e.message) })
      }
    />
  );
}
