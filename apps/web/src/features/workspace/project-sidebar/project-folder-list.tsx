'use client';

import {
  AUTO_FOLDER_LABELS,
  AUTO_FOLDER_ORDER,
  groupSessions,
  type AutoFolderKind,
} from '@/components/projects/session-folder-grouping';
import type { SessionSourceKind } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { FolderNameModal } from '@/features/workspace/project-sidebar/modal/folder-name-modal';
import { FolderShareModal } from '@/features/workspace/project-sidebar/modal/folder-share-modal';
import { SidebarGroupLabel, SidebarMenuButton, useSidebar } from '@/components/ui/sidebar';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useSessionFolderUiStore } from '@/stores/session-folder-ui-store';
import {
  deleteSessionFolder,
  listProjectSessions,
  listSessionFolders,
  setSessionFolder,
  type SessionFolder,
} from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import { Icon as IconMynauiType, Pencil, Share, TrashSolid, UsersSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  CalendarClock,
  EyeOff,
  Folder,
  FolderPlus,
  Mail,
  MoreHorizontal,
  Plus,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { IconType } from 'react-icons/lib';

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
const NO_AUTO_PREFS: Partial<Record<AutoFolderKind, boolean>> = {};

/**
 * The FOLDERS sidebar section — user-created folders as flat rows above the
 * SESSIONS list, styled exactly like session rows (icon in the dot slot, count
 * where the timestamp sits). Clicking a folder opens its home page; sessions
 * are dropped onto rows to file them. Virtual source folders (Slack / Email /
 * Scheduled / Webhooks…) are opt-in via the ⋯ menu.
 */
export function ProjectFolderList({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { holdPeek } = useSidebar();
  const newSession = useNewProjectSession(projectId);

  const [folderModal, setFolderModal] = useState<{ folder: SessionFolder | null } | null>(null);
  const [folderToShare, setFolderToShare] = useState<SessionFolder | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<SessionFolder | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const showAuto = useSessionFolderUiStore(
    (s) => s.showAutoByProject[projectId] ?? NO_AUTO_PREFS,
  );
  const setShowAuto = useSessionFolderUiStore((s) => s.setShowAuto);

  const { data: sessions } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: folders } = useQuery({
    queryKey: ['session-folders', projectId],
    queryFn: () => listSessionFolders(projectId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const moveMutation = useMutation({
    mutationFn: ({ sessionId, folderId }: { sessionId: string; folderId: string | null }) =>
      setSessionFolder(projectId, sessionId, folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to move session');
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

  // Counts only — the section renders flat rows, the sessions stay in SESSIONS.
  const grouped = useMemo(
    () => groupSessions(sessions ?? [], folders ?? []),
    [sessions, folders],
  );
  const autoCounts = useMemo(() => {
    const counts = new Map<AutoFolderKind, number>();
    for (const group of grouped.auto) counts.set(group.kind, group.sessions.length);
    return counts;
  }, [grouped]);

  const enabledAutoKinds = AUTO_FOLDER_ORDER.filter((kind) => showAuto[kind] ?? false);

  const folderHref = (key: string) => `/projects/${projectId}/folders/${key}`;

  const dropHandlers = (folderId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
      e.preventDefault();
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
      moveMutation.mutate({ sessionId, folderId });
    },
  });

  return (
    <div className="flex flex-col space-y-2">
      <SidebarGroupLabel className="text-muted-foreground/60 mt-1 flex h-6 items-center px-0 text-xs font-medium tracking-wider uppercase">
        <div className="flex w-full flex-row items-center gap-0.5">
          <div className="flex min-w-0 flex-1 flex-row items-center gap-0.5 px-2 text-[13px] font-normal">
            <span>Folders</span>
          </div>
          <Hint label="New folder" side="bottom">
            <SidebarMenuButton
              type="button"
              aria-label="New folder"
              onClick={() => setFolderModal({ folder: null })}
              className="text-muted-foreground/90 hover:text-sidebar-foreground flex size-8 shrink-0 items-center justify-center px-2"
            >
              <FolderPlus className="size-3.5" />
            </SidebarMenuButton>
          </Hint>
          <DropdownMenu onOpenChange={holdPeek}>
            <DropdownMenuContent align="start" className="w-48 p-1">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                Show source folders
              </DropdownMenuLabel>
              {AUTO_FOLDER_ORDER.map((kind) => {
                const OptionIcon = SOURCE_ICONS[kind];
                return (
                  <DropdownMenuCheckboxItem
                    key={kind}
                    className="cursor-pointer"
                    checked={showAuto[kind] ?? false}
                    onCheckedChange={(checked) => setShowAuto(projectId, kind, checked === true)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <OptionIcon className="size-4" />
                    {AUTO_FOLDER_LABELS[kind]}
                    <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                      {autoCounts.get(kind) ?? 0}
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                type="button"
                aria-label="Folder options"
                className="text-muted-foreground/90 hover:text-sidebar-foreground flex size-8 shrink-0 items-center justify-center px-2"
              >
                <MoreHorizontal className="size-3" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
          </DropdownMenu>
        </div>
      </SidebarGroupLabel>

      <div className="max-h-56 space-y-px overflow-y-auto">
        {grouped.folders.length === 0 && enabledAutoKinds.length === 0 ? (
          <div className="text-muted-foreground/60 px-2 pb-1 text-xs">
            No folders yet — create one to organize sessions.
          </div>
        ) : (
          <>
            {grouped.folders.map(({ folder, sessions: folderSessions }) => (
              <FolderRow
                key={folder.folder_id}
                name={folder.name}
                count={folderSessions.length}
                icon={Folder}
                shared={folder.visibility === 'project'}
                href={folderHref(folder.folder_id)}
                isActive={!!pathname?.includes(`/folders/${folder.folder_id}`)}
                isDropTarget={dropTarget === folder.folder_id}
                {...dropHandlers(folder.folder_id)}
                menu={
                  <>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => router.push(folderHref(folder.folder_id))}
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
            ))}
            {enabledAutoKinds.map((kind) => (
              <FolderRow
                key={kind}
                name={AUTO_FOLDER_LABELS[kind]}
                count={autoCounts.get(kind) ?? 0}
                icon={SOURCE_ICONS[kind]}
                shared={false}
                href={folderHref(kind)}
                isActive={!!pathname?.includes(`/folders/${kind}`)}
                isDropTarget={false}
                menu={
                  <>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => router.push(folderHref(kind))}
                    >
                      <ArrowUpRight />
                      Open folder
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => setShowAuto(projectId, kind, false)}
                    >
                      <EyeOff />
                      Hide from sidebar
                    </DropdownMenuItem>
                  </>
                }
              />
            ))}
          </>
        )}
      </div>

      <FolderNameModal
        projectId={projectId}
        folder={folderModal?.folder ?? null}
        open={!!folderModal}
        onOpenChange={(open) => !open && setFolderModal(null)}
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
    </div>
  );
}

interface FolderRowProps {
  name: string;
  count: number;
  icon: LucideIcon | IconMynauiType | IconType;
  shared: boolean;
  href: string;
  isActive: boolean;
  isDropTarget: boolean;
  menu: React.ReactNode;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

/** A folder row with the exact anatomy of a session row: leading icon in the
 *  status-dot slot, truncating name, count where the timestamp sits, and a
 *  hover ⋯ menu. No chevron — the row IS a link to the folder's page. */
function FolderRow({
  name,
  count,
  icon: LeadingIcon,
  shared,
  href,
  isActive,
  isDropTarget,
  menu,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="group/folder-row block"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={cn(
          'dark:hover:bg-sidebar-accent/50 hover:bg-sidebar-foreground/7 relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors duration-150',
          isActive
            ? 'dark:bg-sidebar-accent/50 bg-sidebar-foreground/8 text-sidebar-foreground font-medium'
            : 'text-muted-foreground hover:text-sidebar-foreground',
          isDropTarget && 'bg-primary/[0.06] ring-primary/40 ring-1',
        )}
      >
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
          <span className="flex size-4 shrink-0 items-center justify-center">
            <LeadingIcon className="text-muted-foreground/80 size-3.5" />
          </span>
          <span className={cn('min-w-0 flex-1 truncate text-sm', isActive && 'font-medium')}>
            {name}
          </span>
        </Link>

        <div className="flex shrink-0 items-center gap-0">
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
                'text-muted-foreground/60 block w-10 min-w-10 max-w-10 shrink-0 truncate pr-1.5 text-right text-xs tabular-nums',
                'transition-opacity duration-150',
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
              <DropdownMenuContent align="start" className="w-48">
                {menu}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}
