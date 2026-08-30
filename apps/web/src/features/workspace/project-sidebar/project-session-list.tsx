'use client';

import { useTranslations } from 'next-intl';

import {
  directSubsessions,
  isMetaCoordinatorSession,
  matchesSourceFilters,
  matchesStatusFilters,
  SESSION_DISPLAY_STATUS_LABELS,
  sessionDisplayStatus,
  sessionSource,
  spawnedBySessionId,
  type SessionSourceKind,
} from '@/components/projects/session-label';
import { SessionSharedIcon } from '@/components/projects/session-shared-icon';
import { SessionStatusDot as SharedSessionStatusDot } from '@/components/projects/session-status-dot';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { useSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Slack } from '@/features/icon/icons/slack';
import { Telegram } from '@/features/icon/icons/telegram';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import {
  getSessionDisplayTitle,
  groupSessionsByCoordinator,
  projectSessionsRefetchInterval,
  resolveSessionListViewState,
  sessionLastActivityAt,
  shortRelative,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { SessionFilterMenu } from '@/features/workspace/project-sidebar/session-filter-menu';
import {
  groupSessions,
  type SessionSection,
} from '@/features/workspace/project-sidebar/session-grouping';
import { SessionTitle } from '@/features/workspace/project-sidebar/session-title';
import { cn } from '@/lib/utils';
import {
  selectCollapsedSections,
  selectGroupMode,
  selectHiddenSections,
  selectOrderMode,
  selectSourceFilters,
  selectStatusFilters,
  useSessionFilterStore,
} from '@/stores/session-filter-store';
import { shouldBeginSessionSwitch, useSessionSwitchStore } from '@/stores/session-switch-store';
import {
  listProjectSessions,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
} from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import {
  CalendarDotsIcon as CalendarClock,
  CaretRightIcon,
  DotsThreeIcon,
  EnvelopeIcon as Mail,
  FolderSimpleIcon as MetaFolder,
  PencilSimpleIcon,
  ArrowCounterClockwiseIcon as RotateCcw,
  ShareIcon as Share,
  ArrowElbowDownRightIcon as SpawnedBy,
  SquareIcon as Square,
  TrashIcon,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, type ComponentType, type ReactNode } from 'react';

interface ProjectSessionListProps {
  projectId: string;
}

const SESSION_RELATIVE_TIME_CLASS =
  'text-muted-foreground/60 block w-10 min-w-10 max-w-10 shrink-0 truncate text-right text-xs tabular-nums';

/** The one `⋯` box. All three menus in this file — the `Sessions` header, every
 *  section header, and every session row — render `Button variant="ghost"
 *  size="icon-xs"` with THIS class, so the glyph sits on a single vertical
 *  axis at every level of the tree.
 *
 *  The geometry, given every row is `px-2` inside the same column: the trigger
 *  is flush to the right edge of that padded box, so its 24px square spans
 *  `[W-32, W-8]` and the 16px glyph inside spans `[W-28, W-12]` — identical for
 *  all three, at any sidebar width.
 *
 *  Do NOT rebuild this from `SidebarMenuButton`. That primitive's base carries
 *  `p-2 w-full h-8 gap-2 overflow-hidden`; `size-6` only beats `w-full`/`h-8`
 *  through tailwind-merge, and `p-2` survives outright — leaving a 16px icon
 *  overflowing an 8px content box, centered by coincidence rather than by
 *  layout, with a different hover fill than the other two. */
const SESSION_MENU_TRIGGER_CLASS =
  'text-muted-foreground hover:text-sidebar-foreground shrink-0 focus:ring-0 focus-visible:ring-0';

/** Every row that can carry a `⋯` is this tall, so the trigger's 24px square is
 *  centered in an identical 32px line at all three levels. */
const SESSION_ROW_HEIGHT_CLASS = 'h-8';

const SOURCE_ICONS: Record<
  Exclude<SessionSourceKind, 'chat'>,
  ComponentType<{ className?: string }>
> = {
  slack: Slack,
  telegram: Telegram,
  email: Mail,
  schedule: CalendarClock,
  webhook: Webhook,
};

// Staggered (unique) widths so the loading state reads as a list of rows, not a
// block; the width doubles as a stable key.
const SKELETON_ROW_WIDTHS = ['w-40', 'w-28', 'w-44', 'w-32', 'w-48', 'w-24', 'w-36', 'w-20'];

/** Loading placeholder mirroring the session-row layout: status dot · title · time. */
function ProjectSessionListSkeleton() {
  return (
    <div className="space-y-px" aria-hidden>
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-8 items-center gap-2 px-2">
          <Skeleton className="size-2 shrink-0 rounded-full py-0" />
          <Skeleton className={cn('h-3 py-0', width)} />
          <Skeleton className="ml-auto h-3 w-7 shrink-0 py-0" />
        </div>
      ))}
    </div>
  );
}

export function ProjectSessionList({ projectId }: ProjectSessionListProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { holdPeek } = useSidebar();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeOpenCodeSessionId = searchParams.get('oc');
  const activeSessionId = pathname?.match(/\/sessions\/([^/?]+)/)?.[1] ?? null;
  const switchingToSessionId = useSessionSwitchStore((state) => state.targetSessionId);
  const beginSessionSwitch = useSessionSwitchStore((state) => state.beginSwitch);
  const cancelSessionSwitch = useSessionSwitchStore((state) => state.cancelSwitch);
  const queryClient = useQueryClient();
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [sessionToShare, setSessionToShare] = useState<ProjectSession | null>(null);
  const [sessionToRename, setSessionToRename] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    refetchInterval: (query) =>
      projectSessionsRefetchInterval({
        sessions: query.state.data as ProjectSession[] | undefined,
        hasOpenSession: Boolean(activeSessionId),
      }),
    // Focus IS the cross-tab signal this list has: a session started in
    // another tab (the home send is the default creation path now) has no
    // other way to appear here before the 60s open-session poll. The
    // sessions page already refetches on focus for the same reason.
    refetchOnWindowFocus: true,
    ...contract('inventory'),
  });

  // Review Center is one coherent system: the per-session row indicators, the
  // footer "Review" pill, and the Customize rail all read the SAME inbox summary
  // and gate on the SAME flag. When the flag is off the summary query never runs,
  // so no indicators render and nothing polls.
  const reviewEnabled = useFeatureFlag(projectId, 'review_center').enabled;
  const reviewSummary = useReviewSessionSummary(projectId, { enabled: reviewEnabled });

  // Grouping, ordering, and the two multi-select facets all live in the
  // persisted session-filter store (keyed by project) — see SessionFilterMenu,
  // which writes to the same store from the nested `⋯` menu.
  // No `surface` argument anywhere here: the sidebar IS the default surface,
  // and it keeps the bare projectId key it has always persisted under.
  const groupMode = useSessionFilterStore(selectGroupMode(projectId));
  const orderMode = useSessionFilterStore(selectOrderMode(projectId));
  const statusFilters = useSessionFilterStore(selectStatusFilters(projectId));
  const sourceFilters = useSessionFilterStore(selectSourceFilters(projectId));
  const hiddenSections = useSessionFilterStore(selectHiddenSections(projectId));
  const collapsedSections = useSessionFilterStore(selectCollapsedSections(projectId));
  const collapsedSectionIds = useMemo(() => new Set(collapsedSections), [collapsedSections]);
  const toggleSectionCollapsed = useSessionFilterStore((s) => s.toggleSectionCollapsed);

  const restartMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      restartProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`Restarting "${label}"…`);
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  const stopMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      stopProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`"${label}" stopped`);
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to stop session');
    },
  });

  // Unsorted on purpose: nothing here reads the order. The two consumers are
  // `.length` and `.filter()`, and `groupSessions` sorts each section itself —
  // sorting twice per render bought nothing.
  const sessions = data ?? [];
  // Filtering itself lives in the nested `⋯` menu (SessionFilterMenu, mounted
  // both on the Sessions header and on every section header below); this list
  // only applies the two ANDed multi-select facets from the store.
  const visibleSessions = sessions.filter(
    (session) =>
      matchesStatusFilters(session, statusFilters) && matchesSourceFilters(session, sourceFilters),
  );

  const viewState = resolveSessionListViewState({
    isLoading,
    isError,
    totalCount: sessions.length,
    visibleCount: visibleSessions.length,
  });

  // Everything below the header — skeleton, error, empty, or the grouped list.
  // Kept as one function so the header stays mounted across all four states
  // instead of being re-declared at every early return.
  function renderBody() {
    if (viewState === 'loading') {
      return <ProjectSessionListSkeleton />;
    }

    if (viewState === 'error') {
      const message = error instanceof Error ? error.message : undefined;
      return (
        <div className="space-y-1.5 px-2 py-2">
          <p className="text-destructive/80 text-xs">
            {tHardcodedUi.raw(
              'componentsProjectsProjectSessionList.line120JsxTextFailedToLoadSessions',
            )}
          </p>
          {message && (
            <p className="text-muted-foreground/70 truncate text-xs" title={message}>
              {message}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => refetch()}
          >
            Retry
          </Button>
        </div>
      );
    }

    if (viewState === 'empty') {
      return (
        <div className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs">
          {tHardcodedUi.raw('componentsProjectsProjectSessionList.line132JsxTextNoSessionsYet')}
        </div>
      );
    }

    if (viewState === 'no-matches') {
      return (
        <div className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs">
          {tI18nHardcoded.raw(
            'autoFeaturesCoWorkerProjectSidebarProjectSessionListJsxText1fba7ca0',
          )}
        </div>
      );
    }

    // Below the early returns: grouping is only ever read by the content state,
    // and computing it above meant every loading/error/empty render paid for a
    // result it threw away.
    const grouped = groupSessions(visibleSessions, {
      mode: groupMode,
      order: orderMode,
      reviewCountBySession: reviewSummary.needsYouBySession,
      hiddenSections,
    });

    // `resolveSessionListViewState` only sees counts before filtering by
    // `hiddenSections` — it has no way to know every section got hidden. Catch
    // that case here instead of letting `FadedScrollArea` render nothing with
    // no explanation.
    if (grouped.sections.length === 0) {
      return (
        <div className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs">All sections hidden.</div>
      );
    }

    // One session row plus its opencode sub-sessions. `nested` marks a row drawn
    // under its coordinator: the indent already carries the spawn link, so the
    // row drops its own spawned-by icon.
    const renderSessionNode = (session: ProjectSession, nested: boolean) => {
      const href = `/projects/${session.project_id}/sessions/${session.session_id}`;
      const isActive = pathname?.includes(`/sessions/${session.session_id}`);
      const isSwitchTarget = switchingToSessionId === session.session_id;
      const children = directSubsessions(session);
      return (
        <div key={session.session_id} className="space-y-px">
          <ProjectSessionRow
            nested={nested}
            session={session}
            href={href}
            isActive={!!isActive && !activeOpenCodeSessionId}
            isSwitching={isSwitchTarget}
            onNavigate={(event) => {
              if (switchingToSessionId && session.session_id === activeSessionId) {
                event.preventDefault();
                cancelSessionSwitch();
                router.replace(href, { scroll: false });
                return;
              }
              if (shouldBeginSessionSwitch(event, session.session_id, activeSessionId)) {
                beginSessionSwitch(session.session_id);
              }
            }}
            displayTitle={getSessionDisplayTitle(session)}
            childCount={children.length}
            reviewCount={reviewSummary.needsYouBySession[session.session_id] ?? 0}
            onDelete={(id, label) => setSessionToDelete({ id, label })}
            onShare={(s) => setSessionToShare(s)}
            onRename={(id, name) => setSessionToRename({ id, name })}
            onRestart={(id, label) => restartMutation.mutate({ sessionId: id, label })}
            isRestarting={
              restartMutation.isPending &&
              restartMutation.variables?.sessionId === session.session_id
            }
            onStop={(id, label) => stopMutation.mutate({ sessionId: id, label })}
            isStopping={
              stopMutation.isPending && stopMutation.variables?.sessionId === session.session_id
            }
          />
          {children.length > 0 && isActive && (
            <div className="border-border ml-3.5 border-l-2 pl-2">
              {children.map((child) => {
                const childHref = `${href}?oc=${encodeURIComponent(child.id)}`;
                const activeChild = !!isActive && activeOpenCodeSessionId === child.id;
                return (
                  <ProjectSubsessionRow
                    key={child.id}
                    title={child.title || 'Sub-session'}
                    href={childHref}
                    isActive={activeChild}
                    updatedAt={child.updated_at}
                  />
                );
              })}
            </div>
          )}
        </div>
      );
    };

    return (
      <FadedScrollArea className="h-full min-h-0 space-y-1">
        {grouped.sections.map((section) => (
          <SessionListSection
            key={section.id}
            section={section}
            projectId={projectId}
            sessions={sessions}
            reviewCountBySession={reviewSummary.needsYouBySession}
            showHeader={grouped.showHeaders}
            open={!collapsedSectionIds.has(section.id)}
            onOpenChange={() => toggleSectionCollapsed(projectId, section.id)}
          >
            {/* Two independent groupings compose here: `groupSessions` splits the
                list into sections, then within each section
                `groupSessionsByCoordinator` nests spawned sessions under the
                coordinator that started them. */}
            {groupSessionsByCoordinator(section.sessions).map((group) => (
              <div key={group.session.session_id} className="space-y-px">
                {renderSessionNode(group.session, false)}
                {group.children.length > 0 && (
                  <div className="border-border ml-3.5 space-y-px border-l-2 pl-1">
                    {group.children.map((child) => renderSessionNode(child, true))}
                  </div>
                )}
              </div>
            ))}
          </SessionListSection>
        ))}
      </FadedScrollArea>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col space-y-2">
      <SessionListHeader
        projectId={projectId}
        sessions={sessions}
        reviewCountBySession={reviewSummary.needsYouBySession}
        onMenuOpenChange={holdPeek}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{renderBody()}</div>

      <ShareSessionModal
        projectId={projectId}
        session={sessionToShare}
        open={!!sessionToShare}
        onOpenChange={(open) => !open && setSessionToShare(null)}
        onSaved={() =>
          queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) })
        }
      />

      <RenameSessionModal
        projectId={projectId}
        sessionId={sessionToRename?.id ?? null}
        currentName={sessionToRename?.name}
        open={!!sessionToRename}
        onOpenChange={(open) => !open && setSessionToRename(null)}
      />

      <SessionDeleteModal
        projectId={projectId}
        sessionId={sessionToDelete?.id ?? null}
        sessionLabel={sessionToDelete?.label}
        open={!!sessionToDelete}
        onOpenChange={(open) => !open && setSessionToDelete(null)}
      />
    </div>
  );
}

/** The `Sessions` row above the list. Lives here — not in `project-sidebar.tsx`
 *  — because everything it needs (the session list, the review summary, the
 *  filter facets) is already read by `ProjectSessionList`; hoisting it up meant
 *  a second `qk.project.sessions(projectId)` query and two files owning the
 *  same horizontal padding. The label opens the full sessions page; the `⋯`
 *  opens the nested Grouping/Ordering/Show/Filters menu (`SessionFilterMenu`)
 *  and appears whenever there is at least one session. */
function SessionListHeader({
  projectId,
  sessions,
  reviewCountBySession,
  onMenuOpenChange,
}: {
  projectId: string;
  sessions: ProjectSession[];
  reviewCountBySession: Record<string, number>;
  onMenuOpenChange: (open: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'flex w-full shrink-0 flex-row items-center gap-1 px-2',
        SESSION_ROW_HEIGHT_CLASS,
      )}
    >
      <HoverPrefetchLink
        href={`/projects/${projectId}/sessions`}
        className="text-muted-foreground hover:text-sidebar-foreground flex min-w-0 flex-1 flex-row items-center self-stretch text-sm font-medium transition-colors duration-150"
      >
        <span className="truncate">Sessions</span>
      </HoverPrefetchLink>
      {sessions.length > 0 && (
        <DropdownMenu onOpenChange={onMenuOpenChange}>
          <SessionFilterMenu
            projectId={projectId}
            sessions={sessions}
            reviewCountBySession={reviewCountBySession}
            align="start"
          />
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label="Session view options"
              className={SESSION_MENU_TRIGGER_CLASS}
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </DropdownMenu>
      )}
    </div>
  );
}

interface SessionListSectionProps {
  section: SessionSection;
  projectId: string;
  sessions: ProjectSession[];
  reviewCountBySession: Record<string, number>;
  showHeader: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** Non-sticky by design: FadedScrollArea masks its own edges, and a sticky
 *  header fights that mask.
 *
 *  When `showHeader` is false (at most one section is populated — see
 *  `groupSessions`'s `showHeaders`), there is nothing to collapse or open a
 *  menu on, so this renders the plain, always-expanded container it always
 *  has. Otherwise the whole section is a `Disclosure`: `open` reflects the
 *  store's collapsed-section list (collapsed = NOT open), so the header
 *  toggle and the section's `Collapse all` menu action agree. */
function SessionListSection({
  section,
  projectId,
  sessions,
  reviewCountBySession,
  showHeader,
  open,
  onOpenChange,
  children,
}: SessionListSectionProps) {
  if (!showHeader) {
    return <div className="space-y-px">{children}</div>;
  }

  return (
    <Disclosure
      open={open}
      onOpenChange={onOpenChange}
      className="group/section space-y-px"
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <DisclosureTrigger>
        <div
          className={cn(
            'group/section-header text-muted-foreground flex items-center gap-1 px-2 text-sm font-medium',
            SESSION_ROW_HEIGHT_CLASS,
          )}
        >
          <span className="truncate">{section.label}</span>
          <CaretRightIcon
            aria-hidden
            className="size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/section-header:opacity-100 group-data-[state=open]/section:rotate-90"
          />
          <SessionSectionMenu
            projectId={projectId}
            sessions={sessions}
            reviewCountBySession={reviewCountBySession}
          />
        </div>
      </DisclosureTrigger>
      <DisclosureContent contentClassName="space-y-px">{children}</DisclosureContent>
    </Disclosure>
  );
}

/** The section header's own `⋯` — mounts the SAME `SessionFilterMenu` as the
 *  Sessions header (project-sidebar.tsx), no section-scoped filter state.
 *  Hover-revealed via `group/section-header` on the header row only (not the
 *  whole `group/section` disclosure), so hovering a row inside the section
 *  doesn't also fade in the header's `⋯`; stays visible while its own menu is
 *  open via `data-[state=open]`, which Radix stamps on this trigger directly
 *  (not the group). Both the click AND keydown (Enter/Space) handlers stop
 *  propagation so opening the menu — by pointer or keyboard — never also
 *  toggles the disclosure, which Radix's `pointerdown` open would otherwise
 *  race against the header's `onKeyDown`-driven `toggle()` — same pattern as
 *  the row-level `⋯` in `ProjectSessionRow`. The hit area extends past the
 *  visible button with `before:absolute before:-inset-1` instead of growing
 *  the button, so the `h-6` header never changes height. */
function SessionSectionMenu({
  projectId,
  sessions,
  reviewCountBySession,
}: {
  projectId: string;
  sessions: ProjectSession[];
  reviewCountBySession: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label="Section options"
          className={cn(
            SESSION_MENU_TRIGGER_CLASS,
            'relative ml-auto opacity-0 transition-opacity duration-150',
            'before:absolute before:-inset-1',
            'group-hover/section-header:opacity-100 data-[state=open]:opacity-100',
          )}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
            }
          }}
        >
          <DotsThreeIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <SessionFilterMenu
        projectId={projectId}
        sessions={sessions}
        reviewCountBySession={reviewCountBySession}
        align="start"
      />
    </DropdownMenu>
  );
}

interface ProjectSessionRowProps {
  session: ProjectSession;
  href: string;
  isActive: boolean;
  isSwitching: boolean;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  displayTitle: string;
  onDelete: (sessionId: string, label: string) => void;
  onShare: (session: ProjectSession) => void;
  onRename: (sessionId: string, currentName: string) => void;
  onRestart: (sessionId: string, label: string) => void;
  isRestarting: boolean;
  onStop: (sessionId: string, label: string) => void;
  isStopping: boolean;
  childCount?: number;
  /** How many review items from this session are awaiting the human (`needs_you`). */
  reviewCount?: number;
  /** Rendered indented under its coordinator — the indent already conveys the
   *  spawn link, so the right-side spawned-by icon is omitted. */
  nested?: boolean;
}

function ProjectSessionRow({
  session,
  href,
  isActive,
  isSwitching,
  onNavigate,
  displayTitle,
  onDelete,
  onShare,
  onRename,
  onRestart,
  isRestarting,
  onStop,
  isStopping,
  childCount = 0,
  reviewCount = 0,
  nested = false,
}: ProjectSessionRowProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [menuOpen, setMenuOpen] = useState(false);

  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const activity = (() => {
    try {
      const date = new Date(sessionLastActivityAt(session));
      return {
        relative: formatDistanceToNowStrict(date, { addSuffix: false }),
        exact: format(date, 'MMM d, yyyy, h:mm a'),
      };
    } catch {
      return null;
    }
  })();

  const source = sessionSource(session);
  const SourceIcon = source.kind !== 'chat' ? SOURCE_ICONS[source.kind] : null;
  const isMeta = isMetaCoordinatorSession(session);
  const spawnedBy = spawnedBySessionId(session);

  return (
    <div className="group/session-list block">
      <div
        className={cn(
          // --session-row-surface paints the row AND the title fade in the same
          // style pass. Do not transition background — transition-colors made the
          // fill ease for 150ms while the fade snapped, which read as a flicker.
          'relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-none',
          isActive
            ? 'text-sidebar-foreground bg-[var(--session-row-surface)] font-medium [--session-row-surface:var(--sidebar-border)]'
            : 'text-muted-foreground hover:text-sidebar-foreground bg-[var(--session-row-surface)] [--session-row-surface:var(--sidebar)] hover:[--session-row-surface:var(--sidebar-border)]',
        )}
      >
        {/* HoverPrefetchLink, not `<Link>`: a bare Link prefetches every row in
            the viewport, so opening ONE session made the browser fetch the RSC
            payload of every OTHER session in the sidebar — 19-20 dynamic server
            renders (~24KB each) per open, 21 hits on this one route where 1 is
            correct. The prefetch now starts on hover/focus/touch. */}
        <HoverPrefetchLink
          href={href}
          onClick={onNavigate}
          aria-busy={isSwitching || undefined}
          aria-current={isActive ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch"
        >
          <SessionStatusDot session={session} reviewCount={reviewCount} />

          {isMeta && (
            <Hint side="top" label="Meta coordinator">
              <span className="text-muted-foreground/80 flex size-4 shrink-0 items-center justify-center">
                <MetaFolder className="size-3.5" weight="fill" />
              </span>
            </Hint>
          )}

          <SessionTitle title={displayTitle} className={cn(isActive && 'font-medium')} />

          {childCount > 0 && (
            <span className="bg-sidebar-accent/60 text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-xs tabular-nums">
              {childCount}
            </span>
          )}
        </HoverPrefetchLink>

        <div className="flex shrink-0 items-center gap-0" data-session-indicators="true">
          {spawnedBy && !nested && (
            <Hint side="top" label={`Spawned by session ${spawnedBy.slice(0, 8)}`}>
              <span className="text-muted-foreground/70 flex size-4 shrink-0 items-center justify-center">
                <SpawnedBy className="size-3" />
              </span>
            </Hint>
          )}
          {SourceIcon && (
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              data-session-source="true"
            >
              <Hint
                side="top"
                label={
                  source.triggerSlug ? `${source.label} · ${source.triggerSlug}` : source.label
                }
              >
                <span className="text-muted-foreground/70 flex size-4 items-center justify-center">
                  <SourceIcon className="size-3" />
                </span>
              </Hint>
            </span>
          )}
          <SessionSharedIcon session={session} />

          <div className="relative w-10 min-w-10 shrink-0">
            {activity && (
              <span
                className={cn(
                  SESSION_RELATIVE_TIME_CLASS,
                  // pr-1 (4px), not pr-1.5: the timestamp and the `⋯` swap in
                  // this same slot on hover, so the text's right edge must land
                  // on the GLYPH's right edge, not the button's. The 16px glyph
                  // is inset 4px inside its 24px box — match that, or the two
                  // states sit 2px apart and the swap visibly shifts.
                  'pr-1 transition-opacity duration-150',
                  'opacity-100 group-hover/session-list:opacity-0 group-has-data-[state=open]/session-list:opacity-0',
                )}
                title={`Last activity: ${activity.exact}`}
                aria-label={`Last activity: ${activity.relative}`}
              >
                {shortRelative(activity.relative)}
              </span>
            )}

            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label={tHardcodedUi.raw(
                    'componentsProjectsProjectSessionList.line312JsxAttrAriaLabelSessionActions',
                  )}
                  className={cn(
                    SESSION_MENU_TRIGGER_CLASS,
                    'absolute top-1/2 right-0 -translate-y-1/2 transition-opacity duration-150',
                    activity
                      ? cn(
                          'pointer-events-none opacity-0',
                          'group-hover/session-list:pointer-events-auto group-hover/session-list:opacity-100',
                          'data-[state=open]:pointer-events-auto data-[state=open]:opacity-100',
                        )
                      : 'opacity-100',
                  )}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <DotsThreeIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right" className="w-44">
                <DropdownMenuItem
                  className="cursor-pointer"
                  onSelect={() => deferAfterClose(() => onRename(session.session_id, displayTitle))}
                >
                  <PencilSimpleIcon />
                  Rename
                </DropdownMenuItem>
                {/* Shown to everyone who can open the session: the owner
                    changes access here, everyone else reads who has it. */}
                <DropdownMenuItem
                  className="cursor-pointer"
                  onSelect={() => deferAfterClose(() => onShare(session))}
                >
                  <Share />
                  {session.can_manage_sharing !== false ? 'Share' : 'Who has access'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  disabled={isRestarting}
                  onSelect={() =>
                    deferAfterClose(() => onRestart(session.session_id, displayTitle))
                  }
                >
                  {isRestarting ? <Loading className="size-4 shrink-0" /> : <RotateCcw />}
                  Restart
                </DropdownMenuItem>
                {/* Lifecycle, not sharing: a project manager keeps Stop on a
                    session they did not create. */}
                {session.status === 'running' && session.can_manage_lifecycle !== false && (
                  <DropdownMenuItem
                    className="cursor-pointer"
                    disabled={isStopping}
                    onSelect={() => deferAfterClose(() => onStop(session.session_id, displayTitle))}
                  >
                    {isStopping ? <Loading className="size-4 shrink-0" /> : <Square />}
                    Stop
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="cursor-pointer"
                  onSelect={() => deferAfterClose(() => onDelete(session.session_id, displayTitle))}
                >
                  <TrashIcon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectSubsessionRow({
  title,
  href,
  isActive,
  updatedAt,
}: {
  title: string;
  href: string;
  isActive: boolean;
  updatedAt: number | null;
}) {
  const relative = updatedAt
    ? shortRelative(formatDistanceToNowStrict(new Date(updatedAt), { addSuffix: false }))
    : '';

  return (
    // Same reason as ProjectSessionRow: sub-session rows are session routes too,
    // so prefetching them on mount multiplies the per-open RSC storm.
    <HoverPrefetchLink href={href} className="block">
      <div
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm transition-colors duration-150',
          isActive ? 'bg-sidebar-accent text-sidebar-foreground font-medium' : '',
        )}
      >
        <span className="bg-muted-foreground/40 h-1 w-1 shrink-0 rounded-full" />
        <span title={title} className={cn('flex-1 truncate', isActive && 'font-medium')}>
          {title}
        </span>
        {relative && <span className={SESSION_RELATIVE_TIME_CLASS}>{relative}</span>}
      </div>
    </HoverPrefetchLink>
  );
}

/** Sidebar wrapper: resolves the session (plus its pending-review count) to a
 *  display status and hands it to the shared dot. The paint table itself lives
 *  in `components/projects/session-status-dot` so the craft run strips render
 *  the identical glyph.
 *
 *  `reviewCount > 0` is the same condition `sessionDisplayStatus` uses to
 *  return `needs-you`, so the label override lands on exactly that state. */
function SessionStatusDot({
  session,
  reviewCount = 0,
}: {
  session: ProjectSession;
  reviewCount?: number;
}) {
  return (
    <SharedSessionStatusDot
      status={sessionDisplayStatus(session, reviewCount)}
      label={
        reviewCount > 0 ? (
          <span className="text-xs">{`${reviewCount} awaiting your review`}</span>
        ) : undefined
      }
    />
  );
}
