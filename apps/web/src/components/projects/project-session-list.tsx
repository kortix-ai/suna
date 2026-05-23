'use client';

import { useState, memo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
  type ProjectSessionStatus,
} from '@/lib/projects-client';

interface ProjectSessionListProps {
  projectId: string;
}

const LIVE_SESSION_STATUSES: ProjectSessionStatus[] = ['queued', 'branching', 'provisioning'];

function shouldPollProjectSessions(sessions: ProjectSession[] | undefined): boolean {
  return (sessions ?? []).some((session) => LIVE_SESSION_STATUSES.includes(session.status));
}

export function ProjectSessionList({ projectId }: ProjectSessionListProps) {
  const pathname = usePathname();
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
      <div className="py-2 px-2 text-[11px] text-red-600 dark:text-red-400">
        Failed to load sessions
      </div>
    );
  }

  const sessions = (data ?? [])
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (sessions.length === 0) {
    return (
      <div className="px-2 pt-1 pb-2 text-[11.5px] text-muted-foreground/60">
        No sessions yet.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-px">
        {sessions.map((session) => {
          const href = `/projects/${session.project_id}/sessions/${session.session_id}`;
          const isActive = pathname?.includes(`/sessions/${session.session_id}`);
          return (
            <ProjectSessionRow
              key={session.session_id}
              session={session}
              href={href}
              isActive={!!isActive}
              onDelete={(id, label) => setSessionToDelete({ id, label })}
              onRestart={(id) => restartMutation.mutate(id)}
              isRestarting={
                restartMutation.isPending &&
                restartMutation.variables === session.session_id
              }
            />
          );
        })}
      </div>

      <AlertDialog
        open={!!sessionToDelete}
        onOpenChange={(open) => !open && setSessionToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently destroy the branch and sandbox for{' '}
              <span className="font-medium text-foreground">{sessionToDelete?.label}</span>
              . This action cannot be undone.
            </AlertDialogDescription>
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
}

const ProjectSessionRow = memo(function ProjectSessionRow({
  session,
  href,
  isActive,
  onDelete,
  onRestart,
  isRestarting,
}: ProjectSessionRowProps) {
  const [isHovering, setIsHovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Keep menu trigger mounted while open so the dropdown stays anchored
  // when the cursor leaves the row.
  const showActions = isHovering || menuOpen;

  // Title source of truth is the cloud DB's `name` column (mirrored from
  // opencode via /v1/projects/sync-opencode-titles). Older rows may still
  // carry the legacy metadata.session_name key, so fall back to it before
  // showing the branch_name slice.
  const legacyMetadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  const titleCandidate = session.name?.trim() || legacyMetadataName?.trim() || null;
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
          'flex h-7 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-150',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        )}
      >
        <SessionStatusDot status={session.status} />

        <span
          className={cn(
            'flex-1 truncate text-[12.5px]',
            isActive && 'font-medium',
          )}
        >
          {displayTitle}
        </span>

        {/* Right slot — timestamp flush-right by default; 3-dots overlay
            in the exact same spot on hover. */}
        <div className="relative ml-auto flex h-4 min-w-[28px] flex-shrink-0 items-center justify-end">
          {relative && (
            <span
              className={cn(
                'text-[9.5px] tabular-nums text-muted-foreground/60 transition-opacity duration-150',
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
                aria-label="Session actions"
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
