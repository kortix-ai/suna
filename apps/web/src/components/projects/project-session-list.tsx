'use client';

import { useTranslations } from 'next-intl';

import { useState, memo } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Loader2, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  deleteProjectSession,
  listProjectSessions,
  restartProjectSession,
  type ProjectSession,
  type ProjectOpenCodeSession,
  type ProjectSessionStatus,
} from '@/lib/projects-client';

interface ProjectSessionListProps {
  projectId: string;
}

const LIVE_SESSION_STATUSES: ProjectSessionStatus[] = ['queued', 'branching', 'provisioning'];

function shouldPollProjectSessions(sessions: ProjectSession[] | undefined): boolean {
  return (sessions ?? []).some((session) => LIVE_SESSION_STATUSES.includes(session.status));
}

function rootOpenCodeSession(session: ProjectSession): ProjectOpenCodeSession | null {
  const opencodeSessions = session.opencode_sessions ?? [];
  const rootId = session.opencode_session_id;
  if (rootId) {
    return opencodeSessions.find((item) => item.id === rootId) ?? null;
  }
  return opencodeSessions.find((item) => !item.parent_id) ?? null;
}

function directSubsessions(session: ProjectSession): ProjectOpenCodeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

export function ProjectSessionList({ projectId }: ProjectSessionListProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeOpenCodeSessionId = searchParams.get('oc');
  const queryClient = useQueryClient();
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; label: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchInterval: (query) =>
      shouldPollProjectSessions(query.state.data as ProjectSession[] | undefined) ? 5_000 : false,
    refetchOnWindowFocus: false,
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteProjectSession(projectId, sessionId),
    onSuccess: () => {
      toast.success('Session deleted');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete session');
    },
  });

  const restartMutation = useMutation({
    mutationFn: (sessionId: string) => restartProjectSession(projectId, sessionId),
    onSuccess: () => {
      toast.success('Restarting session…');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 rounded-lg bg-sidebar-accent/30 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-2 py-2 text-xs text-destructive/80">{tHardcodedUi.raw('componentsProjectsProjectSessionList.line120JsxTextFailedToLoadSessions')}</div>
    );
  }

  const sessions = (data ?? [])
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (sessions.length === 0) {
    return (
      <div className="px-2 pb-2 pt-1 text-xs text-muted-foreground/60">{tHardcodedUi.raw('componentsProjectsProjectSessionList.line132JsxTextNoSessionsYet')}</div>
    );
  }

  return (
    <>
      <div className="space-y-px">
        {sessions.map((session) => {
          const href = `/projects/${session.project_id}/sessions/${session.session_id}`;
          const isActive = pathname?.includes(`/sessions/${session.session_id}`);
          const root = rootOpenCodeSession(session);
          const children = directSubsessions(session);
          return (
            <div key={session.session_id} className="space-y-px">
              <ProjectSessionRow
                session={session}
                href={href}
                isActive={!!isActive && !activeOpenCodeSessionId}
                titleOverride={root?.title ?? undefined}
                childCount={children.length}
                onDelete={(id, label) => setSessionToDelete({ id, label })}
                onRestart={(id) => restartMutation.mutate(id)}
                isRestarting={
                  restartMutation.isPending &&
                  restartMutation.variables === session.session_id
                }
              />
              {children.length > 0 && isActive && (
                <div className="ml-4 border-l border-border/30 pl-1">
                  {children.map((child) => {
                    const childHref = `${href}?oc=${encodeURIComponent(child.id)}`;
                    const activeChild =
                      !!isActive && activeOpenCodeSessionId === child.id;
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

      <AlertDialog
        open={!!sessionToDelete}
        onOpenChange={(open) => !open && setSessionToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tHardcodedUi.raw('componentsProjectsProjectSessionList.line189JsxTextDeleteSession')}</AlertDialogTitle>
            <AlertDialogDescription>{tHardcodedUi.raw('componentsProjectsProjectSessionList.line191JsxTextThisWillPermanentlyDestroyTheBranchAndSandbox')}{' '}
              <span className="font-medium text-foreground">{sessionToDelete?.label}</span>{tHardcodedUi.raw('componentsProjectsProjectSessionList.line193JsxTextThisActionCannotBeUndone')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (sessionToDelete) {
                  deleteMutation.mutate(sessionToDelete.id);
                  setSessionToDelete(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface ProjectSessionRowProps {
  session: ProjectSession;
  href: string;
  isActive: boolean;
  onDelete: (sessionId: string, label: string) => void;
  onRestart: (sessionId: string) => void;
  isRestarting: boolean;
  titleOverride?: string;
  childCount?: number;
}

const ProjectSessionRow = memo(function ProjectSessionRow({
  session,
  href,
  isActive,
  onDelete,
  onRestart,
  isRestarting,
  titleOverride,
  childCount = 0,
}: ProjectSessionRowProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isHovering, setIsHovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Keep menu trigger mounted while open so the dropdown stays anchored
  // when the cursor leaves the row.
  const showActions = isHovering || menuOpen;

  // Title source of truth is the cloud DB's `name` column (mirrored from
  // opencode via /v1/projects/sync-opencode-sessions). Older rows may still
  // carry the legacy metadata.session_name key, so fall back to it before
  // showing the branch_name slice.
  const legacyMetadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  const titleCandidate = titleOverride?.trim() || session.name?.trim() || legacyMetadataName?.trim() || null;
  const fallback = session.branch_name ? session.branch_name.slice(0, 14) : 'session';
  const displayTitle = titleCandidate || fallback;

  const relative = (() => {
    try {
      return formatDistanceToNowStrict(new Date(session.created_at), { addSuffix: false });
    } catch {
      return '';
    }
  })();

  return (
    <Link
      href={href}
      className="block"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-150',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        )}
      >
        <SessionStatusDot status={session.status} />

        <span
          className={cn(
            'flex-1 truncate text-sm',
            isActive && 'font-medium',
          )}
        >
          {displayTitle}
        </span>

        {childCount > 0 && (
          <span className="rounded-full bg-sidebar-accent/60 px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {childCount}
          </span>
        )}

        {/* Right slot — timestamp flush-right by default; 3-dots overlay
            in the exact same spot on hover. */}
        <div className="relative ml-auto flex h-4 min-w-[28px] flex-shrink-0 items-center justify-end">
          {relative && (
            <span
              className={cn(
                'text-xs tabular-nums text-muted-foreground/60 transition-opacity duration-150',
                showActions && 'opacity-0',
              )}
            >
              {shortRelative(relative)}
            </span>
          )}

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={tHardcodedUi.raw('componentsProjectsProjectSessionList.line312JsxAttrAriaLabelSessionActions')}
                className={cn(
                  'absolute right-0 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground cursor-pointer',
                  showActions ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40 p-1">
              <DropdownMenuItem
                className="cursor-pointer"
                disabled={isRestarting}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onRestart(session.session_id);
                }}
              >
                {isRestarting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                Restart
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete(session.session_id, displayTitle);
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Link>
  );
});

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
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        )}
      >
        <span className="h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground/40" />
        <span className={cn('flex-1 truncate', isActive && 'font-medium')}>
          {title}
        </span>
        {relative && (
          <span className="text-xs tabular-nums text-muted-foreground/60">
            {relative}
          </span>
        )}
      </div>
    </Link>
  );
}

function SessionStatusDot({ status }: { status: ProjectSessionStatus }) {
  const isProvisioning =
    status === 'queued' || status === 'branching' || status === 'provisioning';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {isProvisioning ? (
            <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
          ) : (
            <span
              className={cn(
                'block h-1.5 w-1.5 rounded-full',
                status === 'running' && 'bg-emerald-500 animate-pulse',
                status === 'stopped' && 'bg-muted-foreground/50',
                status === 'completed' && 'bg-emerald-500/60',
                status === 'failed' && 'bg-red-500',
              )}
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs capitalize">
        {status}
      </TooltipContent>
    </Tooltip>
  );
}

// date-fns gives "2 minutes" / "5 hours" / "3 days" — compress to "2m" / "5h" / "3d".
function shortRelative(input: string): string {
  const match = input.match(/^(\d+)\s+(second|minute|hour|day|month|year)s?$/);
  if (!match) return input;
  const [, n, unit] = match;
  const suffix =
    unit === 'second' ? 's' :
    unit === 'minute' ? 'm' :
    unit === 'hour'   ? 'h' :
    unit === 'day'    ? 'd' :
    unit === 'month'  ? 'mo' :
    'y';
  return `${n}${suffix}`;
}
