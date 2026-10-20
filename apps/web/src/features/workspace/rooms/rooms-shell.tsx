'use client';

import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { RoomConversation } from '@kortix/sdk';
import { useRoomConversations } from '@kortix/sdk/react';
import { CaretDownIcon, HashIcon, PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

import { BrowseChannelsModal, CreateChannelModal } from './channel-modals';

type RoomsModal = 'create' | 'browse' | null;

/**
 * The Slack layout for /projects/[id]/rooms*: the channel list on the left,
 * the open channel on the right. Below the container's `@2xl` width it shows
 * one pane: the list at /rooms, the channel (with a back button) at
 * /rooms/[roomId].
 */
export function RoomsShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const params = useParams<{ roomId?: string }>();
  const roomId = params?.roomId ?? null;
  const conversations = useRoomConversations(projectId);
  const [modal, setModal] = useState<RoomsModal>(null);
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
          <ChannelSidebar projectId={projectId} activeRoomId={roomId} conversations={conversations} onOpen={setModal} />
        </aside>
        <main className={cn('min-h-0 min-w-0 flex-1 flex-col', roomId ? 'flex' : 'hidden @2xl:flex')}>{children}</main>
      </div>
      <CreateChannelModal
        projectId={projectId}
        open={modal === 'create'}
        onOpenChange={(open) => setModal(open ? 'create' : null)}
      />
      <BrowseChannelsModal
        projectId={projectId}
        joined={joined}
        open={modal === 'browse'}
        onOpenChange={(open) => setModal(open ? 'browse' : null)}
      />
    </>
  );
}

function ChannelSidebar({
  projectId,
  activeRoomId,
  conversations,
  onOpen,
}: {
  projectId: string;
  activeRoomId: string | null;
  conversations: ReturnType<typeof useRoomConversations>;
  onOpen: (modal: Exclude<RoomsModal, null>) => void;
}) {
  const t = useTranslations('rooms');
  const [open, setOpen] = useState(true);
  const channels = useMemo(
    () =>
      (conversations.data ?? [])
        .filter((c) => !c.archived_at)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [conversations.data],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">{t('title')}</h1>
        <Hint label={t('createChannel')} side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label={t('createChannel')} onClick={() => onOpen('create')}>
            <PlusIcon />
          </Button>
        </Hint>
      </header>
      <nav aria-label={t('channels')} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
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
          <section>
            <div className="flex h-7 items-center gap-1 px-1">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 rounded-sm px-1 text-left text-xs font-medium"
              >
                <CaretDownIcon
                  className={cn(
                    'duration-moderate size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none',
                    !open && '-rotate-90',
                  )}
                />
                <span className="truncate">{t('channels')}</span>
              </button>
              <DropdownMenu>
                <Hint label={t('addChannels')}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label={t('addChannels')}>
                      <PlusIcon />
                    </Button>
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onOpen('create')}>{t('createChannel')}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onOpen('browse')}>{t('browseChannels')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {open ? (
              <ul className="space-y-px">
                {channels.map((c) => (
                  <ChannelRow key={c.room_id} projectId={projectId} conversation={c} active={c.room_id === activeRoomId} />
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => onOpen('browse')}
                    className="text-muted-foreground hover:bg-hover hover:text-foreground flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
                  >
                    <span className="bg-muted flex size-5 shrink-0 items-center justify-center rounded-sm">
                      <PlusIcon className="size-3" />
                    </span>
                    <span className="truncate">{t('addChannels')}</span>
                  </button>
                </li>
              </ul>
            ) : null}
          </section>
        )}
      </nav>
    </div>
  );
}

function ChannelRow({
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
          'flex h-7 items-center gap-2 rounded-md px-2 text-sm',
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
