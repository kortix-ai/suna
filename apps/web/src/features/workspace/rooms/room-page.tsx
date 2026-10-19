'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { MessageTimeLabel } from '@/features/session/turn/message-time-label';
import { useTranslations } from '@/i18n/use-translations';
import type { RoomMember, RoomMessage } from '@kortix/sdk';
import { useRoom, useRoomConversations, useRoomMessages } from '@kortix/sdk/react';
import { ArrowLeftIcon, PaperPlaneRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';

import { ParticipantAvatar, conversationTitle } from './room-identity';

/** How close to the bottom (px) still counts as "reading the newest message". */
const STICK_TO_BOTTOM_PX = 120;

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/**
 * /projects/[id]/rooms/[roomId] — one conversation: its members, the newest
 * messages (oldest on top), and a composer. A person member's read cursor
 * moves to the newest message whenever the page is visible.
 */
export function RoomPage({ projectId, roomId }: { projectId: string; roomId: string }) {
  const t = useTranslations('rooms');
  const room = useRoom(projectId, roomId);
  const conversations = useRoomConversations(projectId);
  const messages = useRoomMessages(projectId, roomId);
  const conversation = conversations.data?.find((c) => c.room_id === roomId) ?? null;
  const isMember = conversation !== null;
  const lastSeq = messages.data?.last_seq ?? 0;
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    () => false,
  );

  // Read cursor: once per new newest message, only while a person can see it.
  const markedRef = useRef(0);
  const { mutate: markRead } = messages.markRead;
  useEffect(() => {
    if (!isMember || !visible || lastSeq <= markedRef.current) return;
    markedRef.current = lastSeq;
    markRead(lastSeq);
  }, [isMember, visible, lastSeq, markRead]);

  // Follow new messages while the reader is at the bottom; the first load lands there.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const count = messages.data?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  const title = room.data
    ? conversationTitle(
        room.data.name,
        conversation?.peer ?? null,
        t('direct'),
      )
    : '';
  const heading =
    room.data?.kind === 'direct' && conversation?.peer
      ? t('directWith', { name: conversation.peer.label })
      : title;

  if (room.isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <ErrorState
          size="sm"
          title={t('roomLoadError')}
          action={
            <Button size="sm" variant="outline" onClick={() => room.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border border-b">
        <div className="mx-auto flex w-full max-w-3xl items-start gap-3 px-4 py-4">
          <Hint label={t('back')}>
            <Button asChild variant="ghost" size="icon-sm" aria-label={t('back')}>
              <Link href={`/projects/${projectId}/rooms`}>
                <ArrowLeftIcon />
              </Link>
            </Button>
          </Hint>
          <div className="min-w-0 flex-1 space-y-1">
            {room.isLoading ? (
              <Skeleton className="h-6 w-48" />
            ) : (
              <h1 className="text-foreground truncate text-base font-medium">{heading}</h1>
            )}
            {room.data?.topic ? (
              <p className="text-muted-foreground text-sm text-balance">{room.data.topic}</p>
            ) : null}
            {room.data ? <MemberLine members={room.data.members} /> : null}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-5">
          {messages.isLoading ? (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : messages.isError ? (
            <ErrorState
              size="sm"
              title={t('messagesLoadError')}
              action={
                <Button size="sm" variant="outline" onClick={() => messages.refetch()}>
                  {t('retry')}
                </Button>
              }
            />
          ) : count === 0 ? (
            <EmptyState size="sm" title={t('emptyThread')} description={t('emptyThreadHint')} />
          ) : (
            <ol className="space-y-4">
              {messages.data!.messages.map((message) => (
                <MessageRow key={message.message_id} message={message} />
              ))}
            </ol>
          )}
        </div>
      </div>

      <RoomComposer
        onSend={async (text) => {
          atBottomRef.current = true;
          await messages.post.mutateAsync({ text });
        }}
      />
    </div>
  );
}

function MemberLine({ members }: { members: RoomMember[] }) {
  const t = useTranslations('rooms');
  if (members.length === 0) return null;
  // People first, then agents: the order every access surface uses.
  const sorted = [...members].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'person' ? -1 : 1));
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1" aria-label={t('members')}>
      {sorted.map((member) => (
        <li key={member.member_id} className="flex min-w-0 items-center gap-1.5">
          <ParticipantAvatar kind={member.kind} label={member.label} userId={member.user_id} size="xs" />
          <span className="text-muted-foreground max-w-48 truncate text-xs">{member.label}</span>
        </li>
      ))}
    </ul>
  );
}

function MessageRow({ message }: { message: RoomMessage }) {
  const t = useTranslations('rooms');
  const person = message.sender_kind === 'member';
  return (
    <li className="flex gap-3" data-seq={message.seq}>
      <ParticipantAvatar
        kind={person ? 'person' : 'session'}
        label={message.sender_label}
        userId={message.sender_user_id}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-foreground truncate text-sm font-medium">{message.sender_label}</span>
          <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs tabular-nums">
            {person ? null : <span>{t('agent')}</span>}
            <MessageTimeLabel timestamp={Date.parse(message.created_at)} />
            <span>#{message.seq}</span>
            {message.reply_to_seq ? (
              <span aria-label={t('replyTo', { seq: message.reply_to_seq })}>↳ #{message.reply_to_seq}</span>
            ) : null}
          </span>
        </div>
        {/* Plain text: a message is untrusted input, never HTML. */}
        <p className="text-foreground text-sm break-words whitespace-pre-wrap">{message.text}</p>
      </div>
    </li>
  );
}

function RoomComposer({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const t = useTranslations('rooms');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setText('');
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="border-border border-t">
      <form
        className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('composerPlaceholder')}
          aria-label={t('composerPlaceholder')}
          minHeight={36}
          maxHeight={200}
          rows={1}
          className="font-normal"
        />
        <Button type="submit" size="icon-md" disabled={!text.trim() || sending} aria-label={t('send')}>
          {sending ? <Loading className="size-4 shrink-0" /> : <PaperPlaneRightIcon />}
        </Button>
      </form>
    </div>
  );
}
