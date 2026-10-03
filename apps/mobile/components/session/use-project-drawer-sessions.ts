/**
 * useProjectDrawerSessions — the project drawer's session data. Split out of
 * ProjectLeftDrawer (KRTX-1250): the component keeps the switcher, nav pills
 * and rows; this owns everything that fetches and builds the list.
 *
 * KRTX-639: three independent paged queries of top-level sessions, by who
 * started the run. Children load per parent, on expand (`SessionChildren`).
 * Sessions that wait on the user leave the lists for a "Needs you" group at
 * its top. Pages load as the list nears its end; a pull refreshes it; and
 * each open refetches the loaded pages, so a session created or renamed
 * elsewhere shows without a pull.
 */

import { useIsFocused } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { useRefetchOnOpen } from '@/components/session/use-refetch-on-open';
import { haptics } from '@/lib/haptics';
import { useProjectSessionsPaged } from '@/lib/projects/hooks';
import type { ProjectSession } from '@/lib/projects/projects-client';
import type { SessionNeedsYou } from '@/lib/session/needs-you';
import { sessionListState, shouldLoadMoreSessions } from '@/lib/session/session-pages';
import {
  type DrawerSectionId,
  buildDrawerItems,
  isParentExpanded,
  rootRowsOnly,
} from '@/lib/session/session-tree';
import { parentKey, sectionKey, useSessionTreeStore } from '@/stores/session-tree-store';

/** Automated and Shared page size: small, they load only to show a header or a first screen. */
const SIDE_SECTION_PAGE_SIZE = 20;
/** The open refetch waits out the drawer's 420ms slide (`DRAWER_OPEN`). */
const DRAWER_REFETCH_DELAY_MS = 450;

/** Shared empty map: a fresh one per render would re-derive the lists. */
const EMPTY_NEEDS_YOU: ReadonlyMap<string, SessionNeedsYou> = new Map();

export function useProjectDrawerSessions({
  projectId,
  open,
  activeParentSessionId = null,
  needsYouBySession = EMPTY_NEEDS_YOU,
}: {
  projectId: string;
  /** The drawer is open: drives the poll, the Automated section and the open refetch. */
  open: boolean;
  /** The open session's parent (`sessionParentId`): that parent opens by default (KRTX-639). */
  activeParentSessionId?: string | null;
  /** Session id → what it waits on (`needsYouBySession` over the review inbox). */
  needsYouBySession?: ReadonlyMap<string, SessionNeedsYou>;
}) {
  // The drawer stays mounted while a root screen (Billing, a settings page)
  // covers the project.
  // Poll for provisioning rows only while the project screen is focused.
  const isFocused = useIsFocused();
  const choices = useSessionTreeStore((state) => state.choices);
  const sectionOpen = (id: DrawerSectionId) =>
    choices[sectionKey(projectId, id)] ?? id === 'sessions';
  const sharedOpen = sectionOpen('shared');
  const automatedOpen = sectionOpen('automated');
  // Polls only while the drawer is open: its content stays mounted while
  // closed, every poll result re-rendered it (~2 renders per 3 s), and the
  // open refetch below already shows a fresh list.
  const mine = useProjectSessionsPaged(projectId, {
    poll: isFocused && open,
    parent: 'root',
    startedBy: 'me',
  });
  // Shared loads always (its header hides when it is empty); Automated only
  // once opened: a project can hold hundreds of automated runs.
  const shared = useProjectSessionsPaged(projectId, {
    poll: false,
    parent: 'root',
    startedBy: 'others',
    limit: SIDE_SECTION_PAGE_SIZE,
  });
  const automated = useProjectSessionsPaged(projectId, {
    poll: false,
    parent: 'root',
    startedBy: 'automated',
    limit: SIDE_SECTION_PAGE_SIZE,
    enabled: automatedOpen,
  });
  const {
    isPending: projectSessionsPending,
    isError: projectSessionsErrored,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = mine;
  // The side sections' "Show more" rows. `fetchNextPage` is stable; the query
  // objects are new on every render, so the list reads these fields, not them.
  const sharedFetchingNext = shared.isFetchingNextPage;
  const automatedFetchingNext = automated.isFetchingNextPage;
  const fetchNextShared = shared.fetchNextPage;
  const fetchNextAutomated = automated.fetchNextPage;
  const mineRoots = useMemo(() => rootRowsOnly(mine.sessions), [mine.sessions]);
  const sharedRoots = useMemo(() => rootRowsOnly(shared.sessions), [shared.sessions]);
  const automatedRoots = useMemo(() => rootRowsOnly(automated.sessions), [automated.sessions]);
  // Depends on the `refetch` functions (stable), not the query objects (new on
  // every render): the callback must not change on each fetch's re-render.
  const refetchMine = mine.refetch;
  const refetchShared = shared.refetch;
  const refetchAutomated = automated.refetch;
  const refetchAll = useCallback(async () => {
    await Promise.all([
      refetchMine(),
      refetchShared(),
      automatedOpen ? refetchAutomated() : Promise.resolve(),
    ]);
  }, [refetchMine, refetchShared, refetchAutomated, automatedOpen]);
  // Sessions that wait on the user, newest wait first: their own group above
  // the list, from every loaded top-level row. A session not loaded yet (an
  // older page, a child) is left to the Review row's count.
  const needsYouSessions = useMemo(
    () =>
      [...mineRoots, ...sharedRoots, ...automatedRoots]
        .filter((session) => needsYouBySession.has(session.session_id))
        .sort(
          (a, b) =>
            (needsYouBySession.get(b.session_id)?.newestAt ?? 0) -
            (needsYouBySession.get(a.session_id)?.newestAt ?? 0),
        ),
    [mineRoots, sharedRoots, automatedRoots, needsYouBySession],
  );
  const withoutNeedsYou = useCallback(
    (rows: ProjectSession[]) =>
      rows.filter((session) => !needsYouBySession.has(session.session_id)),
    [needsYouBySession],
  );
  const isExpanded = useCallback(
    (session: ProjectSession) =>
      isParentExpanded({
        explicit: choices[parentKey(projectId, session.session_id)],
        isActiveParent: session.session_id === activeParentSessionId,
        searchMatch: undefined,
      }),
    [choices, projectId, activeParentSessionId],
  );
  const items = useMemo(
    () =>
      buildDrawerItems(
        [
          {
            id: 'sessions',
            title: 'Sessions',
            rows: withoutNeedsYou(mineRoots),
            open: sectionOpen('sessions'),
            // No bare heading over nothing: the state block below (loading,
            // error, empty) speaks for an empty list, and Needs you for a
            // list whose every row waits on the user.
            hidden: withoutNeedsYou(mineRoots).length === 0,
            hasMore: hasNextPage,
          },
          {
            id: 'shared',
            title: 'Shared',
            rows: withoutNeedsYou(sharedRoots),
            open: sharedOpen,
            hidden: sharedRoots.length === 0,
            hasMore: shared.hasNextPage,
          },
          {
            id: 'automated',
            title: 'Automated',
            rows: withoutNeedsYou(automatedRoots),
            open: automatedOpen,
            hidden: false,
            hasMore: automated.hasNextPage,
          },
        ],
        isExpanded,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sectionOpen reads `choices`
    [
      mineRoots,
      sharedRoots,
      automatedRoots,
      withoutNeedsYou,
      sharedOpen,
      automatedOpen,
      choices,
      projectId,
      hasNextPage,
      shared.hasNextPage,
      automated.hasNextPage,
      isExpanded,
    ],
  );
  // loading / error / empty / rows — shared with the Sessions page
  // (lib/session/session-pages) so a failed fetch, or a first load paused
  // offline, never reads as "No sessions yet" (COR-146). Judged on the
  // viewer's own list; Shared and Automated add rows, never a verdict.
  const sessionsListState = sessionListState({
    isPending: projectSessionsPending,
    isError: projectSessionsErrored,
    hasSessions: mineRoots.length > 0 || sharedRoots.length > 0 || automatedRoots.length > 0,
  });
  // Only a pull shows the refresh spinner; a background poll does not.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void refetchAll().finally(() => setRefreshing(false));
  }, [refetchAll]);
  // The drawer stays mounted while closed, so its query never remounts: each
  // open refetches the loaded pages in the background (no spinner), so a
  // session created or renamed elsewhere shows without a pull. After the
  // slide (open is 420ms): a response landing mid-slide re-rendered the list
  // while it moved (Jay, 2026-09-27: "not smooth").
  useRefetchOnOpen(open, refetchAll, DRAWER_REFETCH_DELAY_MS);
  const handleRetrySessions = useCallback(() => {
    haptics.tap();
    void refetchAll();
  }, [refetchAll]);
  const handleEndReached = useCallback(() => {
    if (!sectionOpen('sessions')) return;
    if (shouldLoadMoreSessions({ hasNextPage, isFetchingNextPage, isRefreshing: refreshing })) {
      void fetchNextPage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sectionOpen reads `choices`
  }, [choices, projectId, hasNextPage, isFetchingNextPage, refreshing, fetchNextPage]);

  return {
    /** The three sections as one flat list (`buildDrawerItems`). */
    items,
    /** The loaded sessions that wait on the user, newest wait first. */
    needsYouSessions,
    sessionsListState,
    /** True only while a pull is in flight, so its spinner shows and a background poll's does not. */
    refreshing,
    /** The Sessions section's page load: the list footer's loader. */
    isFetchingNextPage,
    /** The side sections' "Show more" rows. */
    sharedFetchingNext,
    automatedFetchingNext,
    fetchNextShared,
    fetchNextAutomated,
    handleRefresh,
    handleRetrySessions,
    handleEndReached,
    /** A parent is expanded: the explicit choice, or the open session's parent (KRTX-639). */
    isExpanded,
  };
}
