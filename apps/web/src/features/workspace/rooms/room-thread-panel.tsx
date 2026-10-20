'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectSession, RoomMember, RoomMessage, RoomPerson } from '@kortix/sdk';
import { useRoomThread } from '@kortix/sdk/react';
import { ArrowLeftIcon, XIcon } from '@phosphor-icons/react';
import { useRef } from 'react';

import { RoomComposer } from './room-composer';
import { MessageRow, RoomMessageList, useTimeFormat } from './room-messages';
import type { MentionTarget } from './room-text';

const EMPTY: RoomMessage[] = [];

/**
 * Slack's thread pane beside the room: the root message, "N replies", the
 * replies (grouped like the room), and a "Reply…" composer that posts into
 * the thread. Below the container's `@5xl` width it covers the room, with a
 * back button.
 */
export function RoomThreadPanel({
  projectId,
  roomId,
  roomName,
  rootSeq,
  members,
  sessions,
  people,
  viewerId,
  targets,
  canPost,
  onClose,
}: {
  projectId: string;
  roomId: string;
  roomName: string;
  rootSeq: number;
  members: readonly RoomMember[];
  sessions: readonly ProjectSession[];
  people: readonly RoomPerson[];
  viewerId: string | null;
  targets: MentionTarget[];
  /** The viewer is in the room. */
  canPost: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('rooms');
  const format = useTimeFormat();
  const thread = useRoomThread(projectId, roomId, rootSeq);
  const atBottomRef = useRef(true);
  const all = thread.data?.messages ?? EMPTY;
  const root = all.find((m) => m.seq === rootSeq) ?? null;
  const replies = root ? all.filter((m) => m.seq !== rootSeq) : EMPTY;

  return (
    <aside
      aria-label={t('thread')}
      className="bg-background border-border absolute inset-0 z-20 flex min-h-0 flex-col @5xl:static @5xl:w-96 @5xl:shrink-0 @5xl:border-l"
    >
      <header className="kx-titlebar-row border-border relative flex shrink-0 items-center gap-1 border-b px-2">
        <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-2">
          <Hint label={t('backToRoom')} side="bottom">
            <Button variant="ghost" size="icon-sm" aria-label={t('backToRoom')} className="@5xl:hidden" onClick={onClose}>
              <ArrowLeftIcon />
            </Button>
          </Hint>
          <h2 className="text-foreground shrink-0 pl-2 text-sm font-semibold @5xl:pl-1">{t('thread')}</h2>
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">#{roomName}</span>
          <Hint label={t('closeThread')} side="bottom">
            <Button variant="ghost" size="icon-sm" aria-label={t('closeThread')} className="hidden @5xl:flex" onClick={onClose}>
              <XIcon />
            </Button>
          </Hint>
        </div>
      </header>
      {thread.isLoading ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-2">
              <Skeleton className="size-10 shrink-0 rounded-sm" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : thread.isError || !root ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <ErrorState
            size="sm"
            title={t('threadLoadError')}
            action={
              <Button size="sm" variant="outline" onClick={() => thread.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        </div>
      ) : (
        <RoomMessageList
          projectId={projectId}
          messages={replies}
          introAlways
          dayDividers={false}
          intro={
            <div className="space-y-2">
              <MessageRow projectId={projectId} message={root} format={format} targets={targets} />
              {replies.length > 0 ? (
                <div className="flex items-center gap-2 px-5 pt-1">
                  <span className="text-muted-foreground shrink-0 text-xs">{t('replyCount', { count: replies.length })}</span>
                  <span aria-hidden className="border-border flex-1 border-t" />
                </div>
              ) : null}
            </div>
          }
          newFromSeq={null}
          targets={targets}
          atBottomRef={atBottomRef}
        />
      )}
      {canPost && root ? (
        <RoomComposer
          placeholder={t('replyPlaceholder')}
          roomName={roomName}
          members={members}
          sessions={sessions}
          people={people}
          viewerId={viewerId}
          autoFocus
          onSend={async (text) => {
            atBottomRef.current = true;
            await thread.post.mutateAsync(text);
          }}
        />
      ) : null}
    </aside>
  );
}
