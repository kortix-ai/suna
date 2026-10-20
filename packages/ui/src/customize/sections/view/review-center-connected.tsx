'use client';

import { useTranslations } from '../../../i18n';
/**
 * Review Center wired to live data: fetches the project's review items, maps the
 * API rows into the inbox view model, and routes the inbox's actions to the right
 * backend flow. Native items go through the `/act` and `/bulk` mutations; adapted
 * items act through THEIR OWN source flow — a Change Request ships via merge,
 * is dismissed via close, and "request changes" persists the feedback + delivers
 * it to the change's agent (the review `/act` endpoint 409s on adapted ids by
 * design). Connector approvals (`call:`) open the shared full-parameter review
 * component. That component resolves one exact call through `resolveApproval`.
 * The presentational inbox (review-center.tsx) is shared with the mock
 * prototype.
 */

import { errorToast, infoToast, successToast } from '../../../primitives/toast';
import { useProjectContext } from '../../../files/project/context';
import { useChangeRequestRecovery } from '../../../files/project/hooks/use-change-request-recovery';
import {
  useCloseChangeRequest,
  useMergeChangeRequest,
  useRequestChangesOnChangeRequest,
} from '../../../files/project/hooks/use-change-requests';
import { useProjectCans } from '../../../internal/lib/use-project-can';
import { useSettingsPanelStore } from '../../../internal/stores/settings-panel-store';
import {
  type ReviewSegment,
  type ReviewVerdict,
  getReviewItem,
  listProjectSessions,
  PROJECT_SESSION_NAME_LOOKUP_LIMIT,
  REVIEW_CONTROL_ACTIONS,
  reviewVerdictAllowed,
} from '@kortix/sdk';
import { clearStartStash, contract, qk, reviewItemsOf } from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiRouter, useUiSearchParams } from '../../../providers/ui-provider';
import { useEffect, useMemo, useState } from 'react';
import {
  invalidateReviewInbox,
  useActReviewItem,
  useBulkActReviewItems,
  useResolveReviewApproval,
  useReviewItems,
} from '../../../workspace/review/hooks/use-review-items';
import { mapApiReviewItem } from '../../../workspace/review/map';
import { connectorCallId, crChangeRequestId, itemDeepLink, planBulkAction } from '../../../workspace/review/review-actions';
import { ReviewCenter } from '../../../workspace/review/review-center';

/**
 * How many session deep links the inbox warms up front. A page holds up to 50
 * items, and each prefetch is a real dynamic RSC render. Eight covers the rows
 * a user can see and click without scrolling.
 */
const PREFETCH_LIMIT = 8;

/** How long the merge-conflict toast with its Resolve button stays up: a
 *  display time, not motion. */
const CONFLICT_TOAST_MS = 10_000;

export function ReviewCenterConnected({ projectName }: { projectName: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  // Which verdicts this viewer gets (KRTX-1720): the leaves each verdict's
  // route asserts, mapped once in `@kortix/sdk` for web and mobile. A read-only
  // role still sees the inbox, with no verdict control. The inbox stays live
  // for every viewer: an unresolved probe offers no verdict.
  const cans = useProjectCans(projectId, REVIEW_CONTROL_ACTIONS);
  const qc = useQueryClient();
  const router = useUiRouter();
  const closeCustomize = useSettingsPanelStore((s) => s.close);
  // The segment is a server filter: each one is its own paged read (KRTX-2316).
  const [segment, setSegment] = useState<ReviewSegment>('needs_you');
  const {
    data,
    isLoading,
    isFetching,
    isFetched,
    isError,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useReviewItems(segment);
  const rows = useMemo(() => reviewItemsOf(data), [data]);
  // A link names one item (`?id=cr:…` from a session's change list). It may be
  // in another segment or past the loaded pages: read it by id.
  const idParam = useUiSearchParams()?.get('id') ?? null;
  const linkedMissing = Boolean(
    idParam && isFetched && !rows.some((row) => row.review_item_id === idParam),
  );
  const linked = useQuery({
    queryKey: [...qk.project.reviewItemsScope(projectId), 'item', idParam ?? ''],
    queryFn: async () => (await getReviewItem(projectId, idParam!)).review_item,
    enabled: Boolean(projectId) && linkedMissing,
    staleTime: 5_000,
    retry: false,
  });
  const linkedRow = linkedMissing ? linked.data : undefined;
  const act = useActReviewItem();
  const bulk = useBulkActReviewItems();
  const resolve = useResolveReviewApproval();
  const merge = useMergeChangeRequest();
  const close = useCloseChangeRequest();
  const requestChanges = useRequestChangesOnChangeRequest();
  const { startRecovery, startingCrId } = useChangeRequestRecovery();

  // Session names for the per-session filter + group headers (sessionId → label).
  // Also names the originating session in each approval's description.
  const { data: sessions } = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId, { limit: PROJECT_SESSION_NAME_LOOKUP_LIMIT }),
    enabled: !!projectId,
    ...contract('inventory'),
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
      (linkedRow ? [...rows, linkedRow] : rows).map((row) =>
        mapApiReviewItem(row, projectName, sessionLabels),
      ),
    [rows, linkedRow, projectName, sessionLabels],
  );

  // The inbox's "Open session" and "See it in the session" controls are buttons
  // inside the presentational inbox, which is shared with the mock prototype and
  // takes an opaque `onOpenSession`. They therefore cannot be anchors from here.
  // Warm the sessions they can reach so the click is served from the segment
  // cache instead of running the RSC fetch cold.
  //
  // Capped, and keyed by the hrefs rather than by `items`. Two reasons, both
  // measured against how this screen actually behaves:
  //  - `/projects/[id]/sessions/[sessionId]` has a `loading.tsx`, so each
  //    prefetch is a real dynamic RSC render on the server, not a no-op.
  //  - `useReviewItems` polls on an 8s `refetchInterval`, so `items` takes a new
  //    identity on every material change. Depending on it re-fired the whole
  //    batch every poll; an inbox with dozens of reviewed sessions turned that
  //    into a standing background load.
  // The join key changes only when the actual destination set changes, and the
  // cap keeps the burst bounded to what a user can plausibly click next.
  const warmHrefs = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) {
      const href = itemDeepLink(projectId, item.sessionId);
      if (href) seen.add(href);
      if (seen.size >= PREFETCH_LIMIT) break;
    }
    return [...seen];
  }, [items, projectId]);
  const warmKey = warmHrefs.join('|');
  useEffect(() => {
    for (const href of warmKey ? warmKey.split('|') : []) router.prefetch(href);
  }, [warmKey, router]);

  const refreshInbox = () => invalidateReviewInbox(qc, projectId);

  function recoverChange(
    item: Extract<(typeof items)[number], { kind: 'change' }>,
    conflicts: string[],
  ) {
    const detail = item.detail;
    if (!detail.crId || detail.number == null) return;
    void startRecovery(
      {
        crId: detail.crId,
        number: detail.number,
        title: item.title,
        headRef: detail.advanced.headRef,
        baseRef: detail.advanced.baseRef,
      },
      {
        kind: 'merge_conflict',
        conflicts,
      },
      closeCustomize,
    );
  }

  function handleAct(id: string, verdict: ReviewVerdict, feedback?: string) {
    // The shared parameter-review component calls this for one exact action.
    const executionId = connectorCallId(id);
    if (executionId) {
      resolve.mutate(
        { executionId, decision: verdict === 'approve' ? 'approve' : 'deny', note: feedback },
        {
          onSuccess: () =>
            verdict === 'approve'
              ? successToast(tI18nComplete.raw('text2b2b0a697042'))
              : infoToast(tI18nComplete.raw('textda404deb110f')),
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
            successToast(tI18nComplete.raw('text0cad31cba248'));
            refreshInbox();
          },
          onError: (e) => {
            if ((e as { code?: string }).code === 'MERGE_CONFLICT') {
              const item = items.find((candidate) => candidate.id === id);
              const conflicts = (e as { data?: { conflicts?: string[] } }).data?.conflicts ?? [];
              refreshInbox();
              if (item?.kind === 'change') {
                errorToast(tI18nComplete.raw('text3923e8556e27'), {
                  description: tI18nComplete.raw('text3d33bdd92001'),
                  duration: CONFLICT_TOAST_MS,
                  actions: [
                    {
                      label: tI18nComplete.raw('texte8a1fa10c8d2'),
                      onClick: () => recoverChange(item, conflicts),
                    },
                  ],
                });
                return;
              }
            }
            errorToast(e.message);
          },
        });
      } else if (verdict === 'reject') {
        close.mutate(crId, {
          onSuccess: () => {
            infoToast(tI18nComplete.raw('text67382c89fdde'));
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
          infoToast(tI18nComplete.raw('text8918eace1b87'));
          return;
        }
        requestChanges.mutate(
          { crId, feedback: note },
          {
            onSuccess: (res) => {
              successToast(
                res.delivering
                  ? tI18nComplete.raw('text99764404a562')
                  : tI18nComplete.raw('text871f77182091'),
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
  // arrives here is already actionable. Only native ids can reach the bulk
  // mutation. The
  // guards below are defense in depth, not the primary filter:
  //  - an connector approval is a live question to the agent; a bulk
  //    "dismiss" must NEVER answer it with a deny, so exec ids resolve only
  //    from a bulk action. Each exact call needs its own parameter review.
  //  - Change Requests have no bulk path (merging needs the diff in view).
  function handleBulkAct(ids: string[], verdict: ReviewVerdict) {
    const { native, resolvable, unsupported } = planBulkAction(ids);
    if (native.length > 0) {
      bulk.mutate({ ids: native, verdict }, { onError: (e) => errorToast(e.message) });
    }
    if (resolvable.length > 0) {
      infoToast(
        tI18nComplete('text869cc2438ce5', {
          value0: resolvable.length,
          value1:
            resolvable.length === 1
              ? tI18nComplete.raw('texte07615d6ccf5')
              : tI18nComplete.raw('text15506f3e0de0'),
        }),
      );
    }
    if (unsupported.length > 0) {
      infoToast(
        tI18nComplete('textda39954e705a', {
          value0: unsupported.length,
          value1:
            unsupported.length === 1
              ? tI18nComplete.raw('text274a70ce834d')
              : tI18nComplete.raw('textb9ad2f00fba7'),
          value2:
            unsupported.length === 1
              ? tI18nComplete.raw('text2ad8a7049d7c')
              : tI18nComplete.raw('textc9a8dc336964'),
        }),
      );
    }
  }

  return (
    <ReviewCenter
      initialItems={items}
      segment={segment}
      onSegmentChange={setSegment}
      loadMore={
        hasNextPage
          ? {
              onLoadMore: () => void fetchNextPage(),
              isLoading: isFetchingNextPage,
              isError: isFetchNextPageError,
            }
          : undefined
      }
      isLoading={isLoading}
      isFetching={isFetching}
      // A linked item outside the pages holds the skeleton until its own read settles.
      isFetched={isFetched && (!linkedMissing || linked.isFetched)}
      isError={isError}
      sessionLabels={sessionLabels}
      onAct={handleAct}
      onBulkAct={handleBulkAct}
      verdictAllowed={(item, verdict) => reviewVerdictAllowed(item, verdict, cans)}
      onRefresh={() => void refetch()}
      recoveringCrId={startingCrId}
      onRecoverChange={recoverChange}
      onOpenSession={(sessionId) => {
        // "See progress" only VIEWS the session — feedback delivery goes through
        // the backend now. Clear any stale queued prompt so navigating can't
        // auto-send a leftover message (e.g. from an earlier client-side attempt).
        const href = itemDeepLink(projectId, sessionId);
        if (!href) return;
        clearStartStash(sessionId);
        closeCustomize();
        // nav-contract: prefetch-only — the shared inbox hands back only a
        // sessionId through `onOpenSession`, so the control is a button there.
        // The effect above has already warmed this href.
        router.push(href);
      }}
    />
  );
}
