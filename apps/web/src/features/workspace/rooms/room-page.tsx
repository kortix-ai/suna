'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { addRoomPerson, updateRoom, type RoomMember, type RoomMessage } from '@kortix/sdk';
import { qk, useRoom, useRoomConversations, useRoomMessages } from '@kortix/sdk/react';
import { ArrowLeftIcon, HashIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ParticipantAvatar } from './room-identity';
import { RoomComposer } from './room-composer';
import { RoomMembersPanel } from './room-members-panel';
import { RoomMessageList } from './room-messages';
import { useMentionTargets, useRoomPeople, useRoomSessions } from './use-room-directory';

const EMPTY_MEMBERS: RoomMember[] = [];
const EMPTY_MESSAGES: RoomMessage[] = [];

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/**
 * /projects/[id]/rooms/[roomId] — one channel, Slack-style: a header with the
 * name, topic and members, the messages, and a composer. A person member's
 * read cursor moves to the newest message whenever the page is visible. A
 * viewer who is not in the channel reads it and can join it.
 */
export function RoomPage({ projectId, roomId }: { projectId: string; roomId: string }) {
  const t = useTranslations('rooms');
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const viewerId = user?.id ?? null;
  const room = useRoom(projectId, roomId);
  const conversations = useRoomConversations(projectId);
  const messages = useRoomMessages(projectId, roomId);
  const sessions = useRoomSessions(projectId);
  const people = useRoomPeople(projectId);
  const conversation = conversations.data?.find((c) => c.room_id === roomId) ?? null;
  const isMember = conversation !== null;
  const members = room.data?.members ?? EMPTY_MEMBERS;
  const lastSeq = messages.data?.last_seq ?? 0;
  const [membersOpen, setMembersOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<RoomMessage | null>(null);
  const atBottomRef = useRef(true);
  const targets = useMentionTargets(members, sessions.sessions, people.data ?? [], viewerId);
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    () => false,
  );

  // The "New" line: where the viewer's read cursor stood when the conversation opened.
  const [newFromSeq, setNewFromSeq] = useState<number | null | undefined>(undefined);
  if (newFromSeq === undefined && conversations.isSuccess && messages.isSuccess) {
    const unread = conversation?.unread ?? 0;
    setNewFromSeq(unread > 0 ? Math.max(1, messages.data.last_seq - unread + 1) : null);
  }

  // Read cursor: once per new newest message, only while a person can see it.
  const markedRef = useRef(0);
  const { mutate: markRead } = messages.markRead;
  useEffect(() => {
    if (!isMember || !visible || lastSeq <= markedRef.current) return;
    markedRef.current = lastSeq;
    markRead(lastSeq);
  }, [isMember, visible, lastSeq, markRead]);

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

  const title = room.data?.name ?? '';

  const join = async () => {
    if (!viewerId) return;
    try {
      await addRoomPerson(projectId, roomId, viewerId);
      await queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId) });
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('joinFailed'));
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <RoomHeader
          projectId={projectId}
          roomId={roomId}
          loading={room.isLoading}
          title={title}
          topic={room.data?.topic ?? null}
          members={members}
          canEdit={isMember}
          membersOpen={membersOpen}
          onToggleMembers={() => setMembersOpen((v) => !v)}
        />
        {messages.isLoading || room.isLoading ? (
          <MessageSkeletons />
        ) : messages.isError ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4">
            <ErrorState
              size="sm"
              title={t('messagesLoadError')}
              action={
                <Button size="sm" variant="outline" onClick={() => messages.refetch()}>
                  {t('retry')}
                </Button>
              }
            />
          </div>
        ) : (
          <RoomMessageList
            projectId={projectId}
            messages={messages.data?.messages ?? EMPTY_MESSAGES}
            intro={<ChannelIntro title={title} />}
            newFromSeq={newFromSeq ?? null}
            targets={targets}
            atBottomRef={atBottomRef}
            onReply={setReplyTo}
          />
        )}
        {room.data && !isMember && !conversations.isLoading ? (
          <JoinBar name={title} onJoin={join} />
        ) : (
          <RoomComposer
            projectId={projectId}
            placeholder={t('messageChannel', { name: title })}
            roomName={title}
            members={members}
            sessions={sessions.sessions}
            people={people.data ?? []}
            viewerId={viewerId}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onSend={async (text, reply) => {
              atBottomRef.current = true;
              await messages.post.mutateAsync({ text, reply_to: reply });
            }}
          />
        )}
      </div>
      {membersOpen && room.data ? (
        <RoomMembersPanel
          projectId={projectId}
          roomId={roomId}
          members={members}
          editable={isMember}
          viewerId={viewerId}
          onClose={() => setMembersOpen(false)}
        />
      ) : null}
    </div>
  );
}

function RoomHeader({
  projectId,
  roomId,
  loading,
  title,
  topic,
  members,
  canEdit,
  membersOpen,
  onToggleMembers,
}: {
  projectId: string;
  roomId: string;
  loading: boolean;
  title: string;
  topic: string | null;
  members: RoomMember[];
  canEdit: boolean;
  membersOpen: boolean;
  onToggleMembers: () => void;
}) {
  const t = useTranslations('rooms');
  const stack = [...members].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'person' ? -1 : 1)).slice(0, 3);

  return (
    <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <Hint label={t('back')} side="bottom">
        <Button asChild variant="ghost" size="icon-sm" aria-label={t('back')} className="@2xl:hidden">
          <Link href={`/projects/${projectId}/rooms`}>
            <ArrowLeftIcon />
          </Link>
        </Button>
      </Hint>
      {loading ? (
        <Skeleton className="h-6 w-48" />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <HashIcon className="text-foreground size-4 shrink-0" />
          <h1 className="text-foreground min-w-0 shrink truncate text-lg font-semibold">{title}</h1>
          <TopicEditor projectId={projectId} roomId={roomId} topic={topic} canEdit={canEdit} />
        </div>
      )}
      {members.length > 0 ? (
        <Hint label={t('viewMembers')} side="bottom">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('viewMembersCount', { count: members.length })}
            aria-pressed={membersOpen}
            onClick={onToggleMembers}
            className={cn('shrink-0 gap-1.5', membersOpen && 'bg-active')}
          >
            <span className="flex -space-x-1">
              {stack.map((m) => (
                <span key={m.member_id} className="ring-background rounded-sm ring-2">
                  <ParticipantAvatar kind={m.kind} label={m.label} userId={m.user_id} size="xs" />
                </span>
              ))}
            </span>
            <span className="tabular-nums">{members.length}</span>
          </Button>
        </Hint>
      ) : null}
    </header>
  );
}

function TopicEditor({
  projectId,
  roomId,
  topic,
  canEdit,
}: {
  projectId: string;
  roomId: string;
  topic: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('rooms');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (draft === null) return;
    const next = draft.trim() || null;
    if (next === topic) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await updateRoom(projectId, roomId, { topic: next });
      await queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId) });
      setDraft(null);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('topicFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (draft !== null) {
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          autoFocus
          size="sm"
          value={draft}
          maxLength={500}
          disabled={saving}
          aria-label={t('topic')}
          placeholder={t('topicPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDraft(null);
          }}
        />
        {saving ? <Loading className="size-4 shrink-0" /> : null}
      </form>
    );
  }

  if (!topic && !canEdit) return null;
  const label = topic ?? t('addTopic');
  return (
    <>
      <span aria-hidden className="text-muted-foreground hidden shrink-0 text-xs @3xl:inline">
        ·
      </span>
      {canEdit ? (
        <button
          type="button"
          onClick={() => setDraft(topic ?? '')}
          title={t('editTopic')}
          className="text-muted-foreground hover:text-foreground hidden min-w-0 truncate text-left text-xs @3xl:block"
        >
          {label}
        </button>
      ) : (
        <span title={label} className="text-muted-foreground hidden min-w-0 truncate text-xs @3xl:block">
          {label}
        </span>
      )}
    </>
  );
}

function ChannelIntro({ title }: { title: string }) {
  const t = useTranslations('rooms');
  return (
    <div className="space-y-2">
      <h2 className="text-foreground flex items-center gap-1 text-xl font-medium">
        <HashIcon className="size-5 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
      </h2>
      <p className="text-muted-foreground text-sm text-pretty">{t('introChannel', { name: title })}</p>
    </div>
  );
}

function JoinBar({ name, onJoin }: { name: string; onJoin: () => Promise<void> }) {
  const t = useTranslations('rooms');
  const [pending, setPending] = useState(false);
  return (
    <div className="shrink-0 px-5 pb-5">
      <div className="bg-popover border-border flex flex-col items-center gap-2 rounded-md border px-4 py-3">
        <p className="text-foreground text-sm">{t('viewingChannel', { name })}</p>
        <Button
          size="sm"
          disabled={pending}
          aria-busy={pending}
          onClick={async () => {
            setPending(true);
            await onJoin();
            setPending(false);
          }}
        >
          {t('joinChannel')}
        </Button>
      </div>
    </div>
  );
}

function MessageSkeletons() {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 px-5 py-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-2">
          <Skeleton className="size-10 shrink-0 rounded-sm" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
