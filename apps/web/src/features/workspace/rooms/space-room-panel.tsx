'use client';

import { Button } from '@kortix/ui/button';
import { ErrorState } from '@kortix/ui/error-state';
import { Skeleton } from '@kortix/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { postRoomMessage, type RoomMember, type RoomMessage } from '@kortix/sdk';
import { qk, useRoom, useRoomMessages, useSpaceRoom } from '@kortix/sdk/react';
import { HashIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, type ReactNode } from 'react';

import { RoomComposer } from './room-composer';
import { RoomMessageList } from './room-messages';
import { useMentionTargets, useRoomPeople, useRoomSessions } from './use-room-directory';

const EMPTY_MEMBERS: RoomMember[] = [];
const EMPTY_MESSAGES: RoomMessage[] = [];

/**
 * `UiHostComponents.RoomPanel`: one room, by name, inside a space page. The
 * room of a space is the project room named like the space's slug. `fill` is
 * the space page's room tab: no frame and no header, the full height. Before
 * anyone posts it does not exist: the panel shows the room's intro and the
 * composer, and the first message creates the room (its creator joins it).
 * Threads, members and the topic stay on the full room page ("Open").
 */
export function SpaceRoomPanel({
  projectId,
  roomName,
  emptyTopic,
  fill = false,
  intro,
}: {
  projectId: string;
  roomName: string;
  emptyTopic?: string;
  fill?: boolean;
  intro?: ReactNode;
}) {
  const t = useTranslations('rooms');
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const viewerId = user?.id ?? null;
  const spaceRoom = useSpaceRoom(projectId, roomName, { topic: emptyTopic ?? null });
  const roomId = spaceRoom.data?.room_id ?? null;
  const room = useRoom(projectId, roomId);
  const messages = useRoomMessages(projectId, roomId, { top: true });
  const sessions = useRoomSessions(projectId);
  const people = useRoomPeople(projectId);
  const members = room.data?.members ?? EMPTY_MEMBERS;
  const targets = useMentionTargets(members, sessions.sessions, people.data ?? [], viewerId);
  const atBottomRef = useRef(true);
  const loading = spaceRoom.isLoading || (roomId !== null && messages.isLoading);

  const send = async (text: string) => {
    atBottomRef.current = true;
    const id = roomId ?? (await spaceRoom.ensure.mutateAsync()).room_id;
    await postRoomMessage(projectId, id, { text });
    await queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId) });
  };

  return (
    <section
      className={
        fill
          ? 'flex h-full min-h-0 flex-col overflow-hidden'
          : 'bg-popover flex h-96 min-h-0 flex-col overflow-hidden rounded-md border'
      }
    >
      {fill ? null : (
        <header className="border-border flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
          <HashIcon className="text-foreground size-4 shrink-0" />
          <h2 className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{roomName}</h2>
          {roomId ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/projects/${projectId}/rooms/${roomId}`}>{t('openRoom')}</Link>
            </Button>
          ) : null}
        </header>
      )}
      {loading ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-5 py-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : spaceRoom.isError || messages.isError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <ErrorState
            size="sm"
            title={t('messagesLoadError')}
            action={
              <Button size="sm" variant="outline" onClick={() => (roomId ? messages.refetch() : spaceRoom.refetch())}>
                {t('retry')}
              </Button>
            }
          />
        </div>
      ) : (
        <RoomMessageList
          projectId={projectId}
          messages={roomId ? (messages.data?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES}
          intro={
            intro ?? <p className="text-muted-foreground px-5 text-sm text-pretty">{t('introRoom', { name: roomName })}</p>
          }
          introAlways={!roomId}
          dayDividers={false}
          newFromSeq={null}
          targets={targets}
          atBottomRef={atBottomRef}
        />
      )}
      {/* An archived room keeps its messages and takes no new ones (the API answers 409). */}
      {spaceRoom.data?.archived_at ? (
        <p className="border-border text-muted-foreground shrink-0 border-t px-4 py-3 text-xs">{t('archivedNotice')}</p>
      ) : (
        <RoomComposer
          placeholder={t('messageRoom', { name: roomName })}
          roomName={roomName}
          members={members}
          sessions={sessions.sessions}
          people={people.data ?? []}
          viewerId={viewerId}
          onSend={send}
        />
      )}
    </section>
  );
}
