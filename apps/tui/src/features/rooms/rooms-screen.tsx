/**
 * The Rooms screen: the conversations the caller is a member of (SPEC §5).
 *
 * This file is the data half. The list is `useRoomConversations`, the open
 * conversation's members are `useRoom` and its messages are `useRoomMessages`
 * (polled by the hook while mounted). Read-only: the TUI posts no message and
 * moves no read cursor; `useRoomMessages(...).post` and `.markRead` are the
 * SDK verbs a later wave can bind.
 *
 * Gated on the project's `agent_rooms` flag, as the web is.
 */

import type { Room, RoomConversation, RoomMember, RoomMessage } from '@kortix/sdk';
import { useFeatureFlag, useRoom, useRoomConversations, useRoomMessages } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { Spinner } from '../../ui/index.ts';
import { type MemberRow, type MessageRow, type RoomRow, RoomsView } from './rooms-view.tsx';

export interface RoomsScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  /** Inner columns. */
  width: number;
  /** Inner rows. */
  height: number;
  /** Kortix web origin, for "open in browser". */
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** Test seam for `o`. Defaults to `lib/open-url.ts`. */
  openUrlImpl?: (url: string) => Promise<unknown>;
}

const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'Unknown error';
  return typeof status === 'number' ? `HTTP ${status}: ${message}` : message;
}

function epochMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export function roomRow(room: RoomConversation): RoomRow {
  return {
    id: room.room_id,
    name: room.name,
    topic: room.topic ?? '',
    unread: room.unread ?? 0,
    memberCount: room.member_count ?? null,
    updatedMs: epochMs(room.updated_at),
  };
}

export function messageRow(message: RoomMessage): MessageRow {
  return {
    id: message.message_id,
    seq: message.seq,
    sender: message.sender_label,
    senderKind: message.sender_kind,
    text: message.text,
    replyTo: message.reply_to_seq,
    atMs: epochMs(message.created_at),
  };
}

export function memberRow(member: RoomMember): MemberRow {
  return {
    id: member.member_id,
    label: member.label,
    kind: member.kind,
    sessionId: member.session_id,
    status: member.status,
  };
}

/** The web route of a conversation. */
export function roomWebUrl(webBaseUrl: string, projectId: string, roomId: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/projects/${projectId}/rooms/${roomId}`;
}

export function RoomsScreen({
  projectId,
  accountId: _accountId,
  sessionId: _sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession,
  onToast,
  openUrlImpl = openUrl,
}: RoomsScreenProps) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const flag = useFeatureFlag(projectId, 'agent_rooms');
  const on = flag.enabled ? projectId : null;
  const conversations = useRoomConversations(on);
  const room = useRoom(on, roomId);
  const thread = useRoomMessages(on, roomId);

  const rooms = useMemo(() => (conversations.data ?? []).map(roomRow), [conversations.data]);
  // The API answers newest-last; sort by seq so a paged merge cannot reorder.
  const messages = useMemo(
    () => [...(thread.data?.messages ?? [])].sort((a, b) => a.seq - b.seq).map(messageRow),
    [thread.data],
  );
  const members = useMemo(
    () => (room.data as (Room & { members?: RoomMember[] }) | undefined)?.members?.map(memberRow) ?? [],
    [room.data],
  );

  const openBrowser = useCallback(
    (row: RoomRow) => {
      if (!projectId) return;
      const url = roomWebUrl(webBaseUrl, projectId, row.id);
      void openUrlImpl(url)
        .then(() => onToast(`Opened ${url}`))
        .catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [projectId, webBaseUrl, openUrlImpl, onToast],
  );

  const refresh = useCallback(() => {
    void Promise.all([conversations.refetch(), roomId ? thread.refetch() : null]).catch(
      (error: unknown) => onToast(errorText(error), 'error'),
    );
  }, [conversations.refetch, thread.refetch, roomId, onToast]);

  if (!projectId) return <text fg={theme.faint}>No project selected.</text>;
  if (flag.isLoading) return <Spinner label="checking Rooms" />;
  if (!flag.enabled) {
    return <text fg={theme.faint}>Rooms are off: the project's agent_rooms feature is not enabled.</text>;
  }

  return (
    <RoomsView
      rooms={rooms}
      messages={roomId ? messages : []}
      members={roomId ? members : []}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={conversations.isLoading}
      messagesLoading={thread.isLoading}
      errorMessage={conversations.isError ? errorText(conversations.error) : null}
      messagesError={thread.isError ? errorText(thread.error) : null}
      onOpenRoom={setRoomId}
      onOpenSession={onOpenSession}
      onOpenBrowser={openBrowser}
      onRefresh={refresh}
      onBack={onBack}
    />
  );
}
