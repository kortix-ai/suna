'use client';

import {
  AUTO_FOLDER_LABELS,
  type AutoFolderKind,
  isAutoFolderKind,
} from '@/components/projects/session-folder-grouping';
import { type SessionSourceKind, sessionSource } from '@/components/projects/session-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { FolderNameModal } from '@/features/workspace/project-sidebar/modal/folder-name-modal';
import { FolderShareModal } from '@/features/workspace/project-sidebar/modal/folder-share-modal';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { cn } from '@/lib/utils';
import {
  type ProjectSession,
  type SessionFolder,
  deleteSessionFolder,
  listProjectSessions,
  listSessionFolders,
} from '@kortix/sdk/projects-client';
import {
  type Icon as IconMynauiType,
  Pencil,
  Share,
  TrashSolid,
  UsersSolid,
} from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  CalendarClock,
  Folder,
  type LucideIcon,
  Mail,
  MoreHorizontal,
  Plus,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { IconType } from 'react-icons/lib';

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

const AUTO_FOLDER_DESCRIPTIONS: Record<AutoFolderKind, string> = {
  slack: 'Sessions started from Slack.',
  telegram: 'Sessions started from Telegram.',
  email: 'Sessions started from email.',
  schedule: 'Sessions started by scheduled triggers.',
  webhook: 'Sessions started by webhook triggers.',
};

/**
 * The little home page every sidebar folder gets — manual folders (by uuid)
 * and virtual auto-folders (by kind: /folders/slack, /folders/schedule, …)
 * render the same way: header with icon + name + meta, actions, and the
 * folder's sessions as entity rows.
 */
export function FolderHomeView({
  projectId,
  folderKey,
}: {
  projectId: string;
  folderKey: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const newSession = useNewProjectSession(projectId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const { data: folders, isLoading: foldersLoading } = useQuery({
    queryKey: ['session-folders', projectId],
    queryFn: () => listSessionFolders(projectId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const isAuto = isAutoFolderKind(folderKey);
  const folder: SessionFolder | null = isAuto
    ? null
    : ((folders ?? []).find((f) => f.folder_id === folderKey) ?? null);

  const folderSessions = useMemo(() => {
    const all = (sessions ?? [])
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (isAuto) {
      // Mirror the sidebar: manually-filed sessions belong to their folder,
      // not the source bucket.
      const manualIds = new Set((folders ?? []).map((f) => f.folder_id));
      return all.filter(
        (s) => sessionSource(s).kind === folderKey && !(s.folder_id && manualIds.has(s.folder_id)),
      );
    }
    return all.filter((s) => s.folder_id === folderKey);
  }, [sessions, folders, folderKey, isAuto]);

  const deleteMutation = useMutation({
    mutationFn: () => deleteSessionFolder(projectId, folderKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-folders', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      successToast('Folder deleted — its sessions were kept');
      router.push(`/projects/${projectId}`);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to delete folder');
    },
  });

  const isLoading = sessionsLoading || foldersLoading;

  if (!isLoading && !isAuto && !folder) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-10 lg:py-20">
            <EmptyState
              icon={Folder}
              title="Folder not found"
              description="It may have been deleted, or it belongs to another member."
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/projects/${projectId}`}>Back to project</Link>
                </Button>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  const title = isAuto ? AUTO_FOLDER_LABELS[folderKey] : (folder?.name ?? '');
  const HeaderIcon = isAuto ? SOURCE_ICONS[folderKey] : Folder;
  const shared = folder?.visibility === 'project';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20 lg:py-20">
          <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-sidebar-accent/60 flex size-9 shrink-0 items-center justify-center rounded-sm">
                <HeaderIcon className="text-muted-foreground size-5" />
              </span>
              <div className="min-w-0 space-y-1">
                {isLoading && !title ? (
                  <Skeleton className="h-6 w-40" />
                ) : (
                  <h2 className="text-foreground truncate text-xl font-medium">{title}</h2>
                )}
                <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                  <span className="tabular-nums">
                    {folderSessions.length} session{folderSessions.length === 1 ? '' : 's'}
                  </span>
                  {isAuto ? (
                    <>
                      <span className="text-muted-foreground/40">&bull;</span>
                      <span className="truncate">{AUTO_FOLDER_DESCRIPTIONS[folderKey]}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground/40">&bull;</span>
                      {shared ? (
                        <Badge variant="outline" size="sm" className="gap-1">
                          <UsersSolid className="size-3" />
                          Shared with project
                        </Badge>
                      ) : (
                        <span>Private</span>
                      )}
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="mt-2 flex shrink-0 items-center gap-1.5 sm:mt-0">
              {!isAuto && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1.5"
                  onClick={() => newSession({ create: { folder_id: folderKey } })}
                >
                  <Plus className="size-4" />
                  New session
                </Button>
              )}
              {!isAuto && folder?.can_manage && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Folder actions">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => setRenameOpen(true)}
                    >
                      <Pencil />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => setShareOpen(true)}
                    >
                      <Share />
                      Share
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer"
                      variant="destructive"
                      onSelect={() => setDeleteOpen(true)}
                    >
                      <TrashSolid />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </header>

          {isLoading ? (
            <div className="space-y-2">
              {['w-full', 'w-full ', 'w-full  '].map((k) => (
                <Skeleton key={k} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : folderSessions.length === 0 ? (
            <EmptyState
              icon={HeaderIcon}
              size="sm"
              title={isAuto ? `No ${title} sessions yet` : 'This folder is empty'}
              description={
                isAuto
                  ? AUTO_FOLDER_DESCRIPTIONS[folderKey]
                  : 'Start a session here, or drag sessions into the folder from the sidebar.'
              }
              action={
                !isAuto ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => newSession({ create: { folder_id: folderKey } })}
                  >
                    <Plus className="size-3.5 shrink-0" />
                    New session
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="space-y-2">
              {folderSessions.map((session) => (
                <FolderSessionRow key={session.session_id} session={session} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {folder && (
        <>
          <FolderNameModal
            projectId={projectId}
            folder={folder}
            open={renameOpen}
            onOpenChange={setRenameOpen}
          />
          <FolderShareModal
            projectId={projectId}
            folder={folder}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Delete folder?"
            description={
              <>
                <span className="font-medium">{folder.name}</span> will be deleted. The sessions
                inside are kept and return to the main list.
              </>
            }
            confirmLabel="Delete folder"
            confirmVariant="destructive"
            isPending={deleteMutation.isPending}
            onConfirm={() => deleteMutation.mutate()}
          />
        </>
      )}
    </div>
  );
}

function FolderSessionRow({ session }: { session: ProjectSession }) {
  const source = sessionSource(session);
  const SourceIcon = source.kind !== 'chat' ? SOURCE_ICONS[source.kind] : null;
  const title =
    session.custom_name?.trim() ||
    session.name?.trim() ||
    (session.branch_name ? session.branch_name.slice(0, 14) : 'session');
  const relative = (() => {
    try {
      return formatDistanceToNowStrict(new Date(session.created_at), { addSuffix: true });
    } catch {
      return '';
    }
  })();

  const statusColor =
    session.status === 'running' || session.status === 'completed'
      ? 'bg-kortix-green'
      : session.status === 'failed'
        ? 'bg-kortix-red'
        : session.status === 'stopped'
          ? 'bg-muted-foreground/50'
          : 'bg-kortix-yellow';

  return (
    <li>
      <Link
        href={`/projects/${session.project_id}/sessions/${session.session_id}`}
        className={cn(
          'group bg-popover hover:bg-accent/50 flex items-center gap-3 rounded-md border px-4 py-2.5',
          'transition-colors duration-150',
        )}
      >
        <span className={cn('size-2 shrink-0 rounded-full', statusColor)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium">{title}</span>
            {SourceIcon && (
              <span className="text-muted-foreground/70 flex size-4 shrink-0 items-center justify-center">
                <SourceIcon className="size-3" />
              </span>
            )}
          </div>
          <p className="text-muted-foreground truncate text-xs">
            {session.owner_email && session.is_owner === false
              ? `Shared by ${session.owner_email} · `
              : ''}
            <span className="capitalize">{session.status}</span>
            {relative ? ` · ${relative}` : ''}
          </p>
        </div>
      </Link>
    </li>
  );
}
