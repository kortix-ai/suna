'use client';

import { Button } from '@kortix/ui/button';
import { CountBadge } from '@kortix/ui/count-badge';
import Hint from '@kortix/ui/hint';
import { Skeleton } from '@kortix/ui/skeleton';
import { useOptionalSidebar } from '@kortix/ui/sidebar';
import { ErrorState } from '@kortix/ui/error-state';
import { SidebarToggle } from '@kortix/ui/workspace';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import type { RoomConversation } from '@kortix/sdk';
import { useRoomConversations } from '@kortix/sdk/react';
import { HashIcon, PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

import { RoomsDialog } from './room-modals';

/**
 * The Slack layout for /projects/[id]/rooms*: the room list on the left, the
 * open room on the right. Below the container's `@2xl` width it shows one
 * pane: the list at /rooms, the room (with a back button) at /rooms/[roomId].
 */
export function RoomsShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const params = useParams<{ roomId?: string }>();
  const roomId = params?.roomId ?? null;
  const conversations = useRoomConversations(projectId);
  const [adding, setAdding] = useState(false);
  const joined = useMemo(() => new Set((conversations.data ?? []).map((c) => c.room_id)), [conversations.data]);

  return (
    <>
      <div className="@container flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'border-border min-h-0 w-full shrink-0 flex-col @2xl:flex @2xl:w-64 @2xl:border-r',
            roomId ? 'hidden' : 'flex',
          )}
        >
          <RoomSidebar projectId={projectId} activeRoomId={roomId} conversations={conversations} onAdd={() => setAdding(true)} />
        </aside>
        <main className={cn('min-h-0 min-w-0 flex-1 flex-col', roomId ? 'flex' : 'hidden @2xl:flex')}>{children}</main>
      </div>
      <RoomsDialog projectId={projectId} joined={joined} open={adding} onOpenChange={setAdding} />
    </>
  );
}

function RoomSidebar({
  projectId,
  activeRoomId,
  conversations,
  onAdd,
}: {
  projectId: string;
  activeRoomId: string | null;
  conversations: ReturnType<typeof useRoomConversations>;
  onAdd: () => void;
}) {
  const t = useTranslations('rooms');
  const sidebar = useOptionalSidebar();
  const rooms = useMemo(
    () =>
      (conversations.data ?? [])
        .filter((c) => !c.archived_at)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [conversations.data],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The project page title bar (`ProjectPageHeader` classes): the sidebar
          opener when the app sidebar is collapsed, and the desktop drag band. */}
      <header
        className="kx-titlebar-row kx-capability-titlebar border-border relative flex shrink-0 items-center gap-1 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-2 pl-2">
          <h1 className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">{t('title')}</h1>
          <Hint label={t('addRooms')} side="bottom">
            <Button variant="ghost" size="icon-sm" aria-label={t('addRooms')} onClick={onAdd}>
              <PlusIcon />
            </Button>
          </Hint>
        </div>
      </header>
      <nav aria-label={t('title')} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {conversations.isError ? (
          <ErrorState
            size="sm"
            title={t('loadError')}
            action={
              <Button size="sm" variant="outline" onClick={() => conversations.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : conversations.isLoading ? (
          <div className="space-y-1 px-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-7 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <ul className="space-y-px">
            {rooms.map((c) => (
              <RoomRow key={c.room_id} projectId={projectId} conversation={c} active={c.room_id === activeRoomId} />
            ))}
            <li>
              <button
                type="button"
                onClick={onAdd}
                className="text-muted-foreground hover:bg-hover hover:text-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
              >
                <span className="bg-muted flex size-5 shrink-0 items-center justify-center rounded-sm">
                  <PlusIcon className="size-3" />
                </span>
                <span className="truncate">{t('addRooms')}</span>
              </button>
            </li>
          </ul>
        )}
      </nav>
    </div>
  );
}

function RoomRow({
  projectId,
  conversation,
  active,
}: {
  projectId: string;
  conversation: RoomConversation;
  active: boolean;
}) {
  const unread = conversation.unread > 0;
  return (
    <li>
      <Link
        href={`/projects/${projectId}/rooms/${conversation.room_id}`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-8 items-center gap-2 rounded-md px-2 text-sm',
          active
            ? 'bg-active text-foreground font-medium'
            : unread
              ? 'text-foreground hover:bg-hover font-semibold'
              : 'text-muted-foreground hover:bg-hover hover:text-foreground',
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <HashIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
        {unread ? <CountBadge count={conversation.unread} tone="waiting" /> : null}
      </Link>
    </li>
  );
}
