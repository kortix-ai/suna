'use client';

import { useTranslations } from 'next-intl';

import {
  directSubsessions,
  matchesSessionFilter,
  sessionSource,
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
import { errorToast, successToast } from '@/components/ui/toast';
import { RenameSessionModal } from '@/features/co-worker/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/co-worker/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/co-worker/project-sidebar/modal/share-session-modal';
import { Icon } from '@/features/icon/icon';
import {
  listProjectSessions,
  restartProjectSession,
  type ProjectSession,
  type ProjectSessionStatus,
} from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { Icon as IconMynauiType, Pencil, Share, TrashSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  CalendarClock,
  Mail,
  MoreHorizontal,
  RotateCcw,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { IconType } from 'react-icons/lib';

interface ProjectSessionListProps {
  projectId: string;
  filter?: SessionFilterValue;
}

const LIVE_SESSION_STATUSES: ProjectSessionStatus[] = ['queued', 'branching', 'provisioning'];

const SESSION_RELATIVE_TIME_CLASS =
  'text-muted-foreground/60 block w-10 min-w-10 max-w-10 shrink-0 truncate text-right text-xs tabular-nums';

const SOURCE_ICONS: Record<
  Exclude<SessionSourceKind, 'chat'>,
  LucideIcon | IconMynauiType | IconType
> = {
  slack: Icon.Slack,
  telegram: Icon.Telegram,
  email: Mail,
  schedule: CalendarClock,
  webhook: Webhook,
};

function shouldPollProjectSessions(sessions: ProjectSession[] | undefined): boolean {
  return (sessions ?? []).some((session) => LIVE_SESSION_STATUSES.includes(session.status));
}

export function ProjectSessionList({ projectId, filter = 'all' }: ProjectSessionListProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeOpenCodeSessionId = searchParams.get('oc');
  const queryClient = useQueryClient();
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [sessionToShare, setSessionToShare] = useState<ProjectSession | null>(null);
  const [sessionToRename, setSessionToRename] = useState<{ id: string; name: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchInterval: (query) =>
      shouldPollProjectSessions(query.state.data as ProjectSession[] | undefined) ? 5_000 : false,
    refetchOnWindowFocus: false,
  });

  const restartMutation = useMutation({
    mutationFn: (sessionId: string) => restartProjectSession(projectId, sessionId),
    onSuccess: () => {
      successToast('Restarting session…');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-sidebar-accent/30 h-8 animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive/80 px-2 py-2 text-xs">
        {tHardcodedUi.raw(
          'componentsProjectsProjectSessionList.line120JsxTextFailedToLoadSessions',
        )}
      </div>
    );
  }

  const sessions = (data ?? [])
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs">
        {tHardcodedUi.raw('componentsProjectsProjectSessionList.line132JsxTextNoSessionsYet')}
      </div>
    );
  }

  // Filtering itself lives in the SESSIONS header dropdown (project-sidebar);
  // this list only applies the chosen filter.
  const visibleSessions = sessions.filter((session) => matchesSessionFilter(session, filter));

  if (visibleSessions.length === 0) {
    return (
      <div className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs">
        {tI18nHardcoded.raw('autoFeaturesCoWorkerProjectSidebarProjectSessionListJsxText1fba7ca0')}
      </div>
    );
  }

  return (
    <>
      <FadedScrollArea className="h-full min-h-0 space-y-px">
        {visibleSessions.map((session) => {
          const href = `/projects/${session.project_id}/sessions/${session.session_id}`;
          const isActive = pathname?.includes(`/sessions/${session.session_id}`);
          const children = directSubsessions(session);
          return (
            <div key={session.session_id} className="space-y-px">
              <ProjectSessionRow
                session={session}
                href={href}
                isActive={!!isActive && !activeOpenCodeSessionId}
                displayTitle={getSessionDisplayTitle(session)}
                childCount={children.length}
                onDelete={(id, label) => setSessionToDelete({ id, label })}
                onShare={(s) => setSessionToShare(s)}
                onRename={(id, name) => setSessionToRename({ id, name })}
                onRestart={(id) => restartMutation.mutate(id)}
                isRestarting={
                  restartMutation.isPending && restartMutation.variables === session.session_id
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

interface ProjectSessionRowProps {
  session: ProjectSession;
  href: string;
  isActive: boolean;
  displayTitle: string;
  onDelete: (sessionId: string, label: string) => void;
  onShare: (session: ProjectSession) => void;
  onRename: (sessionId: string, currentName: string) => void;
  onRestart: (sessionId: string) => void;
  isRestarting: boolean;
  childCount?: number;
}

function ProjectSessionRow({
  session,
  href,
  isActive,
  displayTitle,
  onDelete,
  onShare,
  onRename,
  onRestart,
  isRestarting,
  childCount = 0,
}: ProjectSessionRowProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [menuOpen, setMenuOpen] = useState(false);

  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const relative = (() => {
    try {
      return formatDistanceToNowStrict(new Date(session.created_at), { addSuffix: false });
    } catch {
      return '';
    }
  })();

  const source = sessionSource(session);
  const SourceIcon = source.kind !== 'chat' ? SOURCE_ICONS[source.kind] : null;

  return (
    <div className="group/session-list block">
      <div
        className={cn(
          'dark:hover:bg-sidebar-accent/50 hover:bg-sidebar-foreground/7 relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors duration-150',
          isActive
            ? 'dark:bg-sidebar-accent/50 bg-sidebar-foreground/8 text-sidebar-foreground font-medium'
            : 'text-muted-foreground hover:text-sidebar-foreground',
        )}
      >
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
          <SessionStatusDot status={session.status} />

          <span className={cn('min-w-0 flex-1 truncate text-sm', isActive && 'font-medium')}>
            {displayTitle}
          </span>

          {childCount > 0 && (
            <span className="bg-sidebar-accent/60 text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-xs tabular-nums">
              {childCount}
            </span>
          )}
        </Link>

        <div className="flex shrink-0 items-center gap-0">
          <span className="flex size-4 shrink-0 items-center justify-center">
            {SourceIcon && (
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
            )}
          </span>

          <div className="relative w-10 min-w-10 shrink-0">
            {relative && (
              <span
                className={cn(
                  SESSION_RELATIVE_TIME_CLASS,
                  'pr-1.5 transition-opacity duration-150',
                  'opacity-100 group-hover/session-list:opacity-0 group-has-data-[state=open]/session-list:opacity-0',
                )}
              >
                {shortRelative(relative)}
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
                    relative
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
                  <Pencil />
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
                  onSelect={() => deferAfterClose(() => onRestart(session.session_id))}
                >
                  {isRestarting ? <Loading /> : <RotateCcw />}
                  Restart
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onSelect={() => deferAfterClose(() => onDelete(session.session_id, displayTitle))}
                  variant="destructive"
                >
                  <TrashSolid />
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
        <span className={cn('flex-1 truncate', isActive && 'font-medium')}>{title}</span>
        {relative && <span className={SESSION_RELATIVE_TIME_CLASS}>{relative}</span>}
      </div>
    </Link>
  );
}

function SessionStatusDot({ status }: { status: ProjectSessionStatus }) {
  const isProvisioning = status === 'queued' || status === 'branching' || status === 'provisioning';

  return (
    <Hint side="right" label={<span className="text-xs capitalize">{status}</span>}>
      <div className="flex size-4 shrink-0 items-center justify-center">
        <svg
          height="16"
          viewBox="0 0 16 16"
          width="16"
          strokeLinejoin="round"
          style={{
            color: isProvisioning
              ? 'var(--kortix-yellow)'
              : status === 'running'
                ? 'var(--kortix-green)'
                : status === 'stopped'
                  ? 'var(--muted-foreground)'
                  : status === 'completed'
                    ? 'var(--kortix-green)'
                    : 'var(--kortix-red)',
          }}
          className={cn(
            'relative flex shrink-0 items-center justify-center',
            isProvisioning && 'animate-spin',
          )}
        >
          <circle
            cx="8"
            cy="8"
            r="6.3"
            stroke="currentColor"
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="3 3.4"
          ></circle>
          {(isProvisioning || status === 'failed') && (
            <circle cx="8" cy="8" r="4" fill="currentColor" />
          )}
        </svg>
      </div>
    </Hint>
  );
}

function getSessionDisplayTitle(session: ProjectSession): string {
  const legacyMetadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  const titleCandidate =
    session.custom_name?.trim() || session.name?.trim() || legacyMetadataName?.trim();

  if (titleCandidate) return titleCandidate;
  return session.branch_name ? session.branch_name.slice(0, 14) : 'session';
}

function shortRelative(input: string): string {
  if (input === 'less than a minute') return 'now';
  const match = input.match(/^(\d+)\s+(second|minute|hour|day|month|year)s?$/);
  if (!match) return input;
  if (match[1] === '0' && match[2] === 'second') return 'now';
  const [, n, unit] = match;
  const suffix =
    unit === 'second'
      ? 's'
      : unit === 'minute'
        ? 'm'
        : unit === 'hour'
          ? 'h'
          : unit === 'day'
            ? 'd'
            : unit === 'month'
              ? 'mo'
              : 'y';
  return `${n}${suffix}`;
}
