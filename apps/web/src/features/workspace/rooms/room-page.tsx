'use client';

import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { ErrorState } from '@kortix/ui/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { addRoomPerson, updateRoom, type RoomMember, type RoomMessage } from '@kortix/sdk';
import { SidebarToggle } from '@kortix/ui/workspace';
import { qk, useRoom, useRoomConversations, useRoomMessages, useRoomThread } from '@kortix/sdk/react';
import { ArrowLeftIcon, HashIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { ParticipantAvatar } from './room-identity';
import { RoomComposer } from './room-composer';
import { RoomMembersPanel } from './room-members-panel';
import { repliersOf, RoomMessageList } from './room-messages';
import { RoomThreadPanel } from './room-thread-panel';
import { useMentionTargets, useRoomPeople, useRoomSessions } from './use-room-directory';

const EMPTY_MEMBERS: RoomMember[] = [];
const EMPTY_MESSAGES: RoomMessage[] = [];

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/**
 * /projects/[id]/rooms/[roomId] — one room, Slack-style: a header with the
 * name, topic and members, the top-level messages, and a composer. Replies
 * live in threads: `?thread=<seq>` opens the thread panel beside the room
 * (one side panel at a time, the members panel being the other). A person
 * member's read cursor moves to the newest message whenever the page is
 * visible. A viewer who is not in the room reads it and can join it.
 */
export function RoomPage({ projectId, roomId }: { projectId: string; roomId: string }) {
  const t = useTranslations('rooms');
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const viewerId = user?.id ?? null;
  const room = useRoom(projectId, roomId);
  const conversations = useRoomConversations(projectId);
  const messages = useRoomMessages(projectId, roomId, { top: true });
  const sessions = useRoomSessions(projectId);
  const people = useRoomPeople(projectId);
  const conversation = conversations.data?.find((c) => c.room_id === roomId) ?? null;
  const isMember = conversation !== null;
  const members = room.data?.members ?? EMPTY_MEMBERS;
  const lastSeq = messages.data?.last_seq ?? 0;
  const [membersOpen, setMembersOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const threadParam = Number(searchParams.get('thread'));
  const threadSeq = Number.isInteger(threadParam) && threadParam > 0 ? threadParam : null;
  // A thread opened by link highlights its root in the room once.
  const [linkedSeq] = useState(threadSeq);
  const openThread = (seq: number | null) => {
    if (seq !== null) setMembersOpen(false);
    router.replace(seq === null ? pathname : `${pathname}?thread=${seq}`, { scroll: false });
  };
  // Replier avatars under a root come from its thread when that thread is loaded.
  const openThreadData = useRoomThread(projectId, roomId, threadSeq);
  const repliers = useMemo(() => {
    const replies = (openThreadData.data?.messages ?? []).filter((m) => m.seq !== threadSeq);
    return threadSeq !== null && replies.length > 0 ? new Map([[threadSeq, repliersOf(replies)]]) : undefined;
  }, [openThreadData.data, threadSeq]);
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
    // `unread` counts top-level messages, so the line sits above the unread-th newest one.
    const top = messages.data.messages;
    setNewFromSeq(unread > 0 ? (top[Math.max(0, top.length - unread)]?.seq ?? null) : null);
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
          onToggleMembers={() => {
            if (!membersOpen && threadSeq !== null) openThread(null);
            setMembersOpen((v) => !v);
          }}
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
            intro={<RoomIntro title={title} />}
            newFromSeq={newFromSeq ?? null}
            targets={targets}
            atBottomRef={atBottomRef}
            highlightSeq={linkedSeq}
            repliers={repliers}
            onOpenThread={openThread}
          />
        )}
        {room.data && !isMember && !conversations.isLoading ? (
          <JoinBar name={title} onJoin={join} />
        ) : (
          <RoomComposer
            placeholder={t('messageRoom', { name: title })}
            roomName={title}
            members={members}
            sessions={sessions.sessions}
            people={people.data ?? []}
            viewerId={viewerId}
            onSend={async (text) => {
              atBottomRef.current = true;
              await messages.post.mutateAsync({ text });
            }}
          />
        )}
      </div>
      {threadSeq !== null && room.data ? (
        <RoomThreadPanel
          key={threadSeq}
          projectId={projectId}
          roomId={roomId}
          roomName={title}
          rootSeq={threadSeq}
          members={members}
          sessions={sessions.sessions}
          people={people.data ?? []}
          viewerId={viewerId}
          targets={targets}
          canPost={isMember}
          onClose={() => openThread(null)}
        />
      ) : membersOpen && room.data ? (
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
    <header className="kx-titlebar-row kx-capability-titlebar border-border relative flex shrink-0 items-center gap-1 border-b px-2">
      {/* Below `@2xl` the room list is hidden, so the room header carries the opener. */}
      <span className="flex @2xl:hidden">
        <SidebarToggle />
      </span>
      <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-2 pl-2">
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
      </div>
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

function RoomIntro({ title }: { title: string }) {
  const t = useTranslations('rooms');
  return (
    <div className="space-y-2 px-5">
      <h2 className="text-foreground flex items-center gap-1 text-xl font-medium">
        <HashIcon className="size-5 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
      </h2>
      <p className="text-muted-foreground text-sm text-pretty">{t('introRoom', { name: title })}</p>
    </div>
  );
}

function JoinBar({ name, onJoin }: { name: string; onJoin: () => Promise<void> }) {
  const t = useTranslations('rooms');
  const [pending, setPending] = useState(false);
  return (
    <div className="shrink-0 px-5 pb-5">
      <div className="bg-popover border-border flex flex-col items-center gap-2 rounded-md border px-4 py-3">
        <p className="text-foreground text-sm">{t('viewingRoom', { name })}</p>
        <Button
          size="sm"
          disabled={pending}
          aria-busy={pending}
          onClick={async () => {
            setPending(true);
            try {
              await onJoin();
            } finally {
              setPending(false);
            }
          }}
        >
          {t('joinRoom')}
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
