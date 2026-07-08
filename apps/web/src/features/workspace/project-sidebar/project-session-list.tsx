'use client';

import { useTranslations } from 'next-intl';

import {
  directSubsessions,
  matchesSessionFilter,
  sessionSource,
  type SessionFilterValue,
  type SessionSourceKind,
} from '@/components/projects/session-label';
import { groupSessions } from '@/components/projects/session-folder-grouping';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { FolderNameModal } from '@/features/workspace/project-sidebar/modal/folder-name-modal';
import { FolderShareModal } from '@/features/workspace/project-sidebar/modal/folder-share-modal';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import { Icon } from '@/features/icon/icon';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useSessionFolderUiStore } from '@/stores/session-folder-ui-store';
import {
  deleteSessionFolder,
  listProjectSessions,
  listSessionFolders,
  restartProjectSession,
  setSessionFolder,
  stopProjectSession,
  type ProjectSession,
  type ProjectSessionStatus,
  type SessionFolder,
} from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import { Icon as IconMynauiType, Pencil, Share, TrashSolid, UsersSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Mail,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Square,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
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

const SESSION_DRAG_TYPE = 'application/x-kortix-session';

// Stable fallback for the zustand selector — a fresh `{}` per render changes
// identity every time and re-renders forever (getSnapshot loop).
const NO_EXPANDED_STATE: Record<string, boolean> = {};

function shouldPollProjectSessions(sessions: ProjectSession[] | undefined): boolean {
  return (sessions ?? []).some((session) => LIVE_SESSION_STATUSES.includes(session.status));
}

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
  const queryClient = useQueryClient();
  const [sessionToDelete, setSessionToDelete] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [sessionToShare, setSessionToShare] = useState<ProjectSession | null>(null);
  const [sessionToRename, setSessionToRename] = useState<{ id: string; name: string } | null>(null);

  // Folder modal state. `folderModal` covers create + rename; a create kicked
  // off from a session's "Move to → New folder…" carries the session id so the
  // fresh folder immediately receives it.
  const [folderModal, setFolderModal] = useState<{
    folder: SessionFolder | null;
    moveSessionId?: string;
  } | null>(null);
  const [folderToShare, setFolderToShare] = useState<SessionFolder | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<SessionFolder | null>(null);

  // Drag-and-drop: the folder id a dragged session is currently hovering.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const expandedMap = useSessionFolderUiStore(
    (s) => s.expandedByProject[projectId] ?? NO_EXPANDED_STATE,
  );
  const setExpanded = useSessionFolderUiStore((s) => s.setExpanded);

  const newSession = useNewProjectSession(projectId);

  const { data, isLoading, error } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchInterval: (query) =>
      shouldPollProjectSessions(query.state.data as ProjectSession[] | undefined) ? 5_000 : false,
    refetchOnWindowFocus: false,
  });

  const { data: folders } = useQuery({
    queryKey: ['session-folders', projectId],
    queryFn: () => listSessionFolders(projectId),
    staleTime: 30_000,
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

  const stopMutation = useMutation({
    mutationFn: (sessionId: string) => stopProjectSession(projectId, sessionId),
    onSuccess: () => {
      successToast('Session stopped');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to stop session');
    },
  });

  const moveMutation = useMutation({
    mutationFn: ({ sessionId, folderId }: { sessionId: string; folderId: string | null }) =>
      setSessionFolder(projectId, sessionId, folderId),
    onMutate: async ({ sessionId, folderId }) => {
      await queryClient.cancelQueries({ queryKey: ['project-sessions', projectId] });
      const prev = queryClient.getQueryData<ProjectSession[]>(['project-sessions', projectId]);
      queryClient.setQueryData<ProjectSession[]>(['project-sessions', projectId], (old) =>
        old?.map((s) => (s.session_id === sessionId ? { ...s, folder_id: folderId } : s)),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['project-sessions', projectId], ctx.prev);
      errorToast(err instanceof Error ? err.message : 'Failed to move session');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (folderId: string) => deleteSessionFolder(projectId, folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-folders', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      successToast('Folder deleted — its sessions were kept');
      setFolderToDelete(null);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to delete folder');
    },
  });

  const moveSession = (sessionId: string, folderId: string | null) =>
    moveMutation.mutate({ sessionId, folderId });

  const sessions = useMemo(
    () =>
      (data ?? [])
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [data],
  );

  // Filtering itself lives in the SESSIONS header dropdown (project-sidebar);
  // this list applies the chosen filter, then groups into folders.
  const grouped = useMemo(() => {
    const visible = sessions.filter((session) => matchesSessionFilter(session, filter));
    return groupSessions(visible, folders ?? []);
  }, [sessions, filter, folders]);

  // The folder holding the active session opens by default; an explicit
  // collapse (stored=false) still wins.
  const activeFolderKey = useMemo(() => {
    const active = sessions.find((s) => pathname?.includes(`/sessions/${s.session_id}`));
    if (!active) return null;
    if (active.folder_id && (folders ?? []).some((f) => f.folder_id === active.folder_id)) {
      return active.folder_id;
    }
    const kind = sessionSource(active).kind;
    return kind === 'chat' ? null : kind;
  }, [sessions, folders, pathname]);

  const isExpanded = (key: string) => expandedMap[key] ?? key === activeFolderKey;

  if (isLoading) {
    return <ProjectSessionListSkeleton />;
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

  if (sessions.length === 0 && (folders ?? []).length === 0) {
    return (
      <div className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs">
        {tHardcodedUi.raw('componentsProjectsProjectSessionList.line132JsxTextNoSessionsYet')}
      </div>
    );
  }

  const filtering = filter !== 'all';
  const visibleFolderGroups = filtering
    ? grouped.folders.filter((g) => g.sessions.length > 0)
    : grouped.folders;
  const hasAnyRow =
    visibleFolderGroups.length > 0 || grouped.auto.length > 0 || grouped.loose.length > 0;

  if (!hasAnyRow) {
    return (
      <div className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs">
        {tI18nHardcoded.raw('autoFeaturesCoWorkerProjectSidebarProjectSessionListJsxText1fba7ca0')}
      </div>
    );
  }

  const manualFolders = (folders ?? []).slice().sort((a, b) => a.position - b.position);

  const renderSession = (session: ProjectSession, inFolder: boolean) => {
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
          folders={manualFolders}
          inFolder={inFolder}
          onDelete={(id, label) => setSessionToDelete({ id, label })}
          onShare={(s) => setSessionToShare(s)}
          onRename={(id, name) => setSessionToRename({ id, name })}
          onRestart={(id) => restartMutation.mutate(id)}
          isRestarting={
            restartMutation.isPending && restartMutation.variables === session.session_id
          }
          onStop={(id) => stopMutation.mutate(id)}
          isStopping={stopMutation.isPending && stopMutation.variables === session.session_id}
          onMove={moveSession}
          onNewFolderForSession={(sessionId) =>
            setFolderModal({ folder: null, moveSessionId: sessionId })
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

  const folderDropHandlers = (folderId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(folderId);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDropTarget((current) => (current === folderId ? null : current));
    },
    onDrop: (e: React.DragEvent) => {
      const sessionId = e.dataTransfer.getData(SESSION_DRAG_TYPE);
      if (!sessionId) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      moveSession(sessionId, folderId);
    },
  });

  return (
    <>
      <FadedScrollArea
        className="h-full min-h-0 space-y-px"
        // Dropping on the list background (outside a folder) unfiles the session.
        onDragOver={(e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e: React.DragEvent) => {
          const sessionId = e.dataTransfer.getData(SESSION_DRAG_TYPE);
          if (!sessionId) return;
          e.preventDefault();
          setDropTarget(null);
          moveSession(sessionId, null);
        }}
      >
        {visibleFolderGroups.map(({ folder, sessions: folderSessions }) => {
          const expanded = isExpanded(folder.folder_id);
          return (
            <div key={folder.folder_id} className="space-y-px">
              <FolderRow
                name={folder.name}
                count={folderSessions.length}
                expanded={expanded}
                shared={folder.visibility === 'project'}
                isDropTarget={dropTarget === folder.folder_id}
                icon={expanded ? FolderOpen : Folder}
                onToggle={() => setExpanded(projectId, folder.folder_id, !expanded)}
                {...folderDropHandlers(folder.folder_id)}
                menu={
                  <>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() =>
                        router.push(`/projects/${projectId}/folders/${folder.folder_id}`)
                      }
                    >
                      <ArrowUpRight />
                      Open folder
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => newSession({ create: { folder_id: folder.folder_id } })}
                    >
                      <Plus />
                      New session here
                    </DropdownMenuItem>
                    {folder.can_manage && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onSelect={() => setFolderModal({ folder })}
                        >
                          <Pencil />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onSelect={() => setFolderToShare(folder)}
                        >
                          <Share />
                          Share
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          variant="destructive"
                          onSelect={() => setFolderToDelete(folder)}
                        >
                          <TrashSolid />
                          Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </>
                }
              />
              {expanded && (
                <div className="border-border ml-3.5 border-l-2 pl-2">
                  {folderSessions.length === 0 ? (
                    <div className="text-muted-foreground/50 px-2 py-1.5 text-xs">
                      Empty — drag sessions here
                    </div>
                  ) : (
                    folderSessions.map((s) => renderSession(s, true))
                  )}
                </div>
              )}
            </div>
          );
        })}

        {grouped.auto.map((group) => {
          const expanded = isExpanded(group.kind);
          const SourceIcon = SOURCE_ICONS[group.kind];
          return (
            <div key={group.kind} className="space-y-px">
              <FolderRow
                name={group.label}
                count={group.sessions.length}
                expanded={expanded}
                shared={false}
                isDropTarget={false}
                icon={SourceIcon}
                onToggle={() => setExpanded(projectId, group.kind, !expanded)}
                menu={
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onSelect={() => router.push(`/projects/${projectId}/folders/${group.kind}`)}
                  >
                    <ArrowUpRight />
                    Open folder
                  </DropdownMenuItem>
                }
              />
              {expanded && (
                <div className="border-border ml-3.5 border-l-2 pl-2">
                  {group.sessions.map((s) => renderSession(s, false))}
                </div>
              )}
            </div>
          );
        })}

        {grouped.loose.map((s) => renderSession(s, false))}
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

      <FolderNameModal
        projectId={projectId}
        folder={folderModal?.folder ?? null}
        open={!!folderModal}
        onOpenChange={(open) => !open && setFolderModal(null)}
        onCreated={(created) => {
          const moveId = folderModal?.moveSessionId;
          if (moveId) moveSession(moveId, created.folder_id);
          setExpanded(projectId, created.folder_id, true);
        }}
      />

      <FolderShareModal
        projectId={projectId}
        folder={folderToShare}
        open={!!folderToShare}
        onOpenChange={(open) => !open && setFolderToShare(null)}
      />

      <ConfirmDialog
        open={!!folderToDelete}
        onOpenChange={(open) => !open && setFolderToDelete(null)}
        title="Delete folder?"
        description={
          <>
            <span className="font-medium">{folderToDelete?.name}</span> will be deleted. The
            sessions inside are kept and return to the main list.
          </>
        }
        confirmLabel="Delete folder"
        confirmVariant="destructive"
        isPending={deleteFolderMutation.isPending}
        onConfirm={() => folderToDelete && deleteFolderMutation.mutate(folderToDelete.folder_id)}
      />
    </>
  );
}

interface FolderRowProps {
  name: string;
  count: number;
  expanded: boolean;
  shared: boolean;
  isDropTarget: boolean;
  icon: LucideIcon | IconMynauiType | IconType;
  onToggle: () => void;
  menu: React.ReactNode;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

function FolderRow({
  name,
  count,
  expanded,
  shared,
  isDropTarget,
  icon: FolderIcon,
  onToggle,
  menu,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="group/folder-row"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          'dark:hover:bg-sidebar-accent/50 hover:bg-sidebar-foreground/7 relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors duration-150',
          'text-muted-foreground hover:text-sidebar-foreground',
          isDropTarget && 'bg-primary/[0.06] ring-primary/40 ring-1',
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ChevronRight
            className={cn(
              'text-muted-foreground/70 size-3 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        </span>
        <FolderIcon className="text-muted-foreground/80 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {shared && (
          <Hint side="top" label="Shared with the project">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <UsersSolid className="text-muted-foreground/70 size-3" />
            </span>
          </Hint>
        )}

        <div className="relative w-10 min-w-10 shrink-0">
          <span
            className={cn(
              SESSION_RELATIVE_TIME_CLASS,
              'pr-1.5 transition-opacity duration-150',
              'opacity-100 group-hover/folder-row:opacity-0 group-has-data-[state=open]/folder-row:opacity-0',
            )}
          >
            {count}
          </span>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="Folder actions"
                className={cn(
                  'absolute top-1/2 right-0 -translate-y-1/2 transition-opacity duration-150 focus:ring-0 focus-visible:ring-0',
                  'pointer-events-none opacity-0',
                  'group-hover/folder-row:pointer-events-auto group-hover/folder-row:opacity-100',
                  'data-[state=open]:pointer-events-auto data-[state=open]:opacity-100',
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-48"
              onClick={(e) => e.stopPropagation()}
            >
              {menu}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

interface ProjectSessionRowProps {
  session: ProjectSession;
  href: string;
  isActive: boolean;
  displayTitle: string;
  folders: SessionFolder[];
  inFolder: boolean;
  onDelete: (sessionId: string, label: string) => void;
  onShare: (session: ProjectSession) => void;
  onRename: (sessionId: string, currentName: string) => void;
  onRestart: (sessionId: string) => void;
  isRestarting: boolean;
  onStop: (sessionId: string) => void;
  isStopping: boolean;
  onMove: (sessionId: string, folderId: string | null) => void;
  onNewFolderForSession: (sessionId: string) => void;
  childCount?: number;
}

function ProjectSessionRow({
  session,
  href,
  isActive,
  displayTitle,
  folders,
  inFolder,
  onDelete,
  onShare,
  onRename,
  onRestart,
  isRestarting,
  onStop,
  isStopping,
  onMove,
  onNewFolderForSession,
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
    <div
      className="group/session-list block"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, session.session_id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
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
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="cursor-pointer [&>svg:first-child]:text-muted-foreground">
                    <FolderInput className="size-4" />
                    Move to
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-44">
                    {folders.map((folder) => (
                      <DropdownMenuItem
                        key={folder.folder_id}
                        className="cursor-pointer"
                        disabled={session.folder_id === folder.folder_id}
                        onSelect={() =>
                          deferAfterClose(() => onMove(session.session_id, folder.folder_id))
                        }
                      >
                        <Folder />
                        <span className="truncate">{folder.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {folders.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() =>
                        deferAfterClose(() => onNewFolderForSession(session.session_id))
                      }
                    >
                      <FolderPlus />
                      New folder…
                    </DropdownMenuItem>
                    {inFolder && session.folder_id && (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onSelect={() => deferAfterClose(() => onMove(session.session_id, null))}
                      >
                        <FolderMinus />
                        Remove from folder
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
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
                {session.status === 'running' && session.can_manage_sharing !== false && (
                  <DropdownMenuItem
                    className="cursor-pointer"
                    disabled={isStopping}
                    onSelect={() => deferAfterClose(() => onStop(session.session_id))}
                  >
                    {isStopping ? <Loading /> : <Square />}
                    Stop
                  </DropdownMenuItem>
                )}
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
