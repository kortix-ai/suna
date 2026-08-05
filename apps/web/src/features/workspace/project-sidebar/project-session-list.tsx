'use client';

import { useTranslations } from 'next-intl';

import {
  directSubsessions,
  matchesSessionFilter,
  sessionDisplayStatus,
  sessionSource,
  SESSION_DISPLAY_STATUS_LABELS,
  type SessionDisplayStatus,
  type SessionFilterValue,
  type SessionSourceKind,
} from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import {
  getSessionDisplayTitle,
  groupSessionsForSidebar,
  resolveSessionListViewState,
  sessionLastActivityAt,
  shortRelative,
  shouldPollProjectSessions,
  sortSessionsByLastActivity,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { SessionTitle } from '@/features/workspace/project-sidebar/session-title';
import { useReviewCenterEnabled } from '@/hooks/projects/use-review-center-enabled';
import { cn } from '@/lib/utils';
import { shouldBeginSessionSwitch, useSessionSwitchStore } from '@/stores/session-switch-store';
import {
  listProjectSessions,
  restartProjectSession,
  stopProjectSession,
  type ProjectSession,
} from '@kortix/sdk';
import {
  CalendarDotsIcon as CalendarClock,
  EnvelopeIcon as Mail,
  DotsThreeIcon as MoreHorizontal,
  PencilSimpleIcon,
  ArrowCounterClockwiseIcon as RotateCcw,
  ShareIcon as Share,
  SquareIcon as Square,
  TrashIcon,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ComponentType } from 'react';

interface ProjectSessionListProps {
  projectId: string;
  filter?: SessionFilterValue;
}

const SESSION_RELATIVE_TIME_CLASS =
  'text-muted-foreground/60 block w-10 min-w-10 max-w-10 shrink-0 truncate text-right text-xs tabular-nums';

const SOURCE_ICONS: Record<
  Exclude<SessionSourceKind, 'chat'>,
  ComponentType<{ className?: string }>
> = {
  slack: Icon.Slack,
  telegram: Icon.Telegram,
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

export function ProjectSessionList({ projectId, filter = 'all' }: ProjectSessionListProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchInterval: (query) =>
      shouldPollProjectSessions(query.state.data as ProjectSession[] | undefined) ? 5_000 : false,
    refetchOnWindowFocus: false,
  });

  // Review Center is one coherent system: the per-session row indicators, the
  // footer "Review" pill, and the Customize rail all read the SAME inbox summary
  // and gate on the SAME flag. When the flag is off the summary query never runs,
  // so no indicators render and nothing polls.
  const reviewEnabled = useReviewCenterEnabled(projectId);
  const reviewSummary = useReviewSessionSummary(projectId, { enabled: reviewEnabled });

  const restartMutation = useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; label: string }) =>
      restartProjectSession(projectId, sessionId),
    onSuccess: (_data, { label }) => {
      successToast(`Restarting "${label}"…`);
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
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
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to stop session');
    },
  });

  const sessions = sortSessionsByLastActivity(data ?? []);
  // Filtering itself lives in the SESSIONS header dropdown (project-sidebar);
  // this list only applies the chosen filter.
  const visibleSessions = sessions.filter((session) => matchesSessionFilter(session, filter));
  const grouped = groupSessionsForSidebar(visibleSessions, reviewSummary.needsYouBySession);

  const viewState = resolveSessionListViewState({
    isLoading,
    isError,
    totalCount: sessions.length,
    visibleCount: visibleSessions.length,
  });

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
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => refetch()}>
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
        {tI18nHardcoded.raw('autoFeaturesCoWorkerProjectSidebarProjectSessionListJsxText1fba7ca0')}
      </div>
    );
  }

  return (
    <>
      <FadedScrollArea className="h-full min-h-0 space-y-px">
        {grouped.sections.map((section) => (
          <div key={section.id} className="space-y-px">
            {grouped.showHeaders && (
              <SessionSectionHeader
                label={section.label}
                count={section.showCount ? section.sessions.length : null}
              />
            )}
            {section.sessions.map((session) => {
              const href = `/projects/${session.project_id}/sessions/${session.session_id}`;
              const isActive = pathname?.includes(`/sessions/${session.session_id}`);
              const isSwitchTarget = switchingToSessionId === session.session_id;
              const children = directSubsessions(session);
              return (
                <div key={session.session_id} className="space-y-px">
                  <ProjectSessionRow
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
                      stopMutation.isPending &&
                      stopMutation.variables?.sessionId === session.session_id
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
            })}
          </div>
        ))}
      </FadedScrollArea>

      <ShareSessionModal
        projectId={projectId}
        session={sessionToShare}
        open={!!sessionToShare}
        onOpenChange={(open) => !open && setSessionToShare(null)}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] })}
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
    </>
  );
}

/** Non-sticky by design: FadedScrollArea masks its own edges, and a sticky
 *  header fights that mask. */
function SessionSectionHeader({ label, count }: { label: string; count: number | null }) {
  return (
    <div className="text-muted-foreground/60 flex h-6 items-center gap-1.5 px-2 pt-2 text-[11px] font-medium tracking-wider uppercase">
      <span>{label}</span>
      {count !== null && <span className="tabular-nums">{count}</span>}
    </div>
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

  return (
    <div className="group/session-list block">
      <div
        className={cn(
          // --session-row-surface paints the row AND the title fade in the same
          // style pass. Do not transition background — transition-colors made the
          // fill ease for 150ms while the fade snapped, which read as a flicker.
          'relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-[color] duration-150',
          isActive
            ? 'text-sidebar-foreground bg-[var(--session-row-surface)] font-medium [--session-row-surface:var(--sidebar-border)]'
            : 'text-muted-foreground hover:text-sidebar-foreground bg-[var(--session-row-surface)] [--session-row-surface:var(--sidebar)] hover:[--session-row-surface:var(--sidebar-border)]',
        )}
      >
        <Link
          href={href}
          onClick={onNavigate}
          aria-busy={isSwitching || undefined}
          aria-current={isActive ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch"
        >
          <SessionStatusDot session={session} reviewCount={reviewCount} />

          <SessionTitle title={displayTitle} className={cn(isActive && 'font-medium')} />

          {childCount > 0 && (
            <span className="bg-sidebar-accent/60 text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-xs tabular-nums">
              {childCount}
            </span>
          )}
        </Link>

        <div className="flex shrink-0 items-center gap-0">
          {SourceIcon && (
            <span className="flex size-4 shrink-0 items-center justify-center">
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

          <div className="relative w-10 min-w-10 shrink-0">
            {activity && (
              <span
                className={cn(
                  SESSION_RELATIVE_TIME_CLASS,
                  'pr-1.5 transition-opacity duration-150',
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
                  size="icon-sm"
                  type="button"
                  aria-label={tHardcodedUi.raw(
                    'componentsProjectsProjectSessionList.line312JsxAttrAriaLabelSessionActions',
                  )}
                  className={cn(
                    'absolute top-1/2 right-0 -translate-y-1/2 transition-opacity duration-150 focus:ring-0 focus-visible:ring-0',
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
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem
                  className="cursor-pointer"
                  onSelect={() => deferAfterClose(() => onRename(session.session_id, displayTitle))}
                >
                  <PencilSimpleIcon />
                  Rename
                </DropdownMenuItem>
                {session.can_manage_sharing !== false && (
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onSelect={() => deferAfterClose(() => onShare(session))}
                  >
                    <Share />
                    Share
                  </DropdownMenuItem>
                )}
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
                {session.status === 'running' && session.can_manage_sharing !== false && (
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
    <Link href={href} className="block">
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
    </Link>
  );
}

/** Per-display-status paint. Green appears in exactly two rows — the two that
 *  mean live or actionable. `done` is muted on purpose: it is the change that
 *  drains the green out of a long list and makes the rest mean something. */
const STATUS_DOT_STYLE: Record<
  SessionDisplayStatus,
  { color: string; fill: boolean; dashed: boolean }
> = {
  'needs-you': { color: 'var(--kortix-green)', fill: true, dashed: false },
  starting: { color: 'var(--kortix-yellow)', fill: false, dashed: false },
  running: { color: 'var(--kortix-green)', fill: true, dashed: false },
  done: { color: 'var(--muted-foreground)', fill: false, dashed: false },
  stopped: { color: 'var(--muted-foreground)', fill: false, dashed: true },
  failed: { color: 'var(--kortix-red)', fill: true, dashed: false },
};

function SessionStatusDot({
  session,
  reviewCount = 0,
}: {
  session: ProjectSession;
  reviewCount?: number;
}) {
  const display = sessionDisplayStatus(session, reviewCount);
  const style = STATUS_DOT_STYLE[display];
  const label =
    display === 'needs-you'
      ? `${reviewCount} awaiting your review`
      : SESSION_DISPLAY_STATUS_LABELS[display];

  return (
    <Hint side="right" label={<span className="text-xs">{label}</span>}>
      <div className="flex size-4 shrink-0 items-center justify-center">
        {display === 'starting' ? (
          // Loading is the only spinner in this codebase. The previous
          // implementation span an SVG with animate-spin, which the rule bans.
          <Loading variant="spokes" className="size-3.5 text-[var(--kortix-yellow)]" />
        ) : (
          <svg
            height="16"
            width="16"
            viewBox="0 0 16 16"
            strokeLinejoin="round"
            style={{ color: style.color }}
            className="flex shrink-0 items-center justify-center"
            aria-hidden
          >
            <circle
              cx="8"
              cy="8"
              r="6.3"
              stroke="currentColor"
              fill="none"
              strokeWidth="1.5"
              strokeDasharray={style.dashed ? '3 3.4' : undefined}
            />
            {style.fill && (
              <circle cx="8" cy="8" r={display === 'needs-you' ? 3.2 : 4} fill="currentColor" />
            )}
          </svg>
        )}
      </div>
    </Hint>
  );
}
