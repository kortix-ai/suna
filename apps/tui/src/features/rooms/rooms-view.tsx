/**
 * The Rooms screen, as pixels and keys only.
 *
 * A room is a shared conversation between people and agent sessions. Three
 * levels: the conversation list, one conversation's messages (read-only), and
 * its members. Everything drawn arrives as a prop and everything done leaves as
 * a callback; `rooms-screen.tsx` owns the SDK.
 */

import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { matchesRoomsBinding } from './keys.ts';

export interface RoomRow {
  id: string;
  name: string;
  topic: string;
  /** A person's unread messages. */
  unread: number;
  memberCount: number | null;
  updatedMs: number;
}

export interface MessageRow {
  id: string;
  seq: number;
  sender: string;
  /** `session` is an agent; `member` is a person. */
  senderKind: 'member' | 'session';
  text: string;
  /** The thread root's seq, or null for a top-level message. */
  replyTo: number | null;
  atMs: number;
}

export interface MemberRow {
  id: string;
  label: string;
  kind: 'session' | 'person';
  /** Set for a session member; Enter opens it. */
  sessionId: string | null;
  status: string | null;
}

export interface RoomsViewProps {
  rooms: RoomRow[];
  /** Messages of the open room, oldest first. */
  messages: MessageRow[];
  members: MemberRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  messagesLoading: boolean;
  errorMessage: string | null;
  messagesError: string | null;
  /** `null` closes the conversation. The host fetches the messages for a non-null id. */
  onOpenRoom(roomId: string | null): void;
  onOpenSession(sessionId: string): void;
  onOpenBrowser(room: RoomRow): void;
  onRefresh(): void;
  /** Esc with nothing open. */
  onBack(): void;
}

export function roomRowText(room: RoomRow, width: number): string {
  const right = [
    room.unread > 0 ? `${room.unread} new` : '',
    room.memberCount != null ? `${room.memberCount} members` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const text = room.topic ? `${room.name} · ${room.topic}` : room.name;
  return layoutRow(text, right, Math.max(width - 1, 0));
}

export function memberRowText(member: MemberRow, width: number): string {
  return layoutRow(
    `${member.kind === 'session' ? GLYPH.running : GLYPH.stopped} ${member.label}`,
    member.kind === 'session' ? (member.status ?? 'agent') : 'person',
    Math.max(width - 1, 0),
  );
}

export function RoomsView({
  rooms,
  messages,
  members,
  focused,
  width,
  height,
  now,
  loading,
  messagesLoading,
  errorMessage,
  messagesError,
  onOpenRoom,
  onOpenSession,
  onOpenBrowser,
  onRefresh,
  onBack,
}: RoomsViewProps) {
  const [mode, setMode] = useState<'list' | 'room' | 'members'>('list');
  const [roomCursor, setRoomCursor] = useState<string | null>(rooms[0]?.id ?? null);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  const roomIndex = useMemo(() => {
    const found = rooms.findIndex((room) => room.id === roomCursor);
    return found >= 0 ? found : 0;
  }, [rooms, roomCursor]);
  const currentRoom = rooms[roomIndex] ?? null;

  const memberIndex = useMemo(() => {
    const found = members.findIndex((member) => member.id === memberCursor);
    return found >= 0 ? found : 0;
  }, [members, memberCursor]);

  const step = useCallback(
    (delta: number) => {
      if (mode === 'members') {
        const next = members[Math.min(Math.max(memberIndex + delta, 0), members.length - 1)];
        if (next) setMemberCursor(next.id);
        return;
      }
      const next = rooms[Math.min(Math.max(roomIndex + delta, 0), rooms.length - 1)];
      if (next) setRoomCursor(next.id);
    },
    [mode, members, memberIndex, rooms, roomIndex],
  );

  // Show the newest message when a conversation opens or a new one arrives.
  const newestId = messages.at(-1)?.id ?? null;
  useEffect(() => {
    if (mode !== 'room' || !newestId) return;
    const box = scrollRef.current;
    if (box) box.scrollTo(box.scrollHeight);
  }, [mode, newestId]);

  const pageSize = Math.max(height - 4, 1);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'room') {
      if (matchesRoomsBinding(key, 'back')) {
        setMode('list');
        onOpenRoom(null);
        return;
      }
      if (matchesRoomsBinding(key, 'down')) return scrollRef.current?.scrollBy(1);
      if (matchesRoomsBinding(key, 'up')) return scrollRef.current?.scrollBy(-1);
      if (matchesRoomsBinding(key, 'pageDown')) return scrollRef.current?.scrollBy(pageSize);
      if (matchesRoomsBinding(key, 'pageUp')) return scrollRef.current?.scrollBy(-pageSize);
      if (matchesRoomsBinding(key, 'first')) return scrollRef.current?.scrollTo(0);
      if (matchesRoomsBinding(key, 'last')) {
        const box = scrollRef.current;
        return box ? box.scrollTo(box.scrollHeight) : undefined;
      }
      if (matchesRoomsBinding(key, 'members')) return setMode('members');
      if (matchesRoomsBinding(key, 'browser'))
        return currentRoom ? onOpenBrowser(currentRoom) : undefined;
      if (matchesRoomsBinding(key, 'refresh')) onRefresh();
      return;
    }

    if (mode === 'members') {
      if (matchesRoomsBinding(key, 'back')) return setMode('room');
      if (matchesRoomsBinding(key, 'down')) return step(1);
      if (matchesRoomsBinding(key, 'up')) return step(-1);
      if (matchesRoomsBinding(key, 'open')) {
        const member = members[memberIndex];
        if (member?.sessionId) onOpenSession(member.sessionId);
      }
      return;
    }

    if (matchesRoomsBinding(key, 'back')) return onBack();
    if (matchesRoomsBinding(key, 'down')) return step(1);
    if (matchesRoomsBinding(key, 'up')) return step(-1);
    if (matchesRoomsBinding(key, 'first')) return setRoomCursor(rooms[0]?.id ?? null);
    if (matchesRoomsBinding(key, 'last')) return setRoomCursor(rooms.at(-1)?.id ?? null);
    if (matchesRoomsBinding(key, 'refresh')) return onRefresh();
    if (matchesRoomsBinding(key, 'browser'))
      return currentRoom ? onOpenBrowser(currentRoom) : undefined;
    if (matchesRoomsBinding(key, 'open') && currentRoom) {
      setMode('room');
      onOpenRoom(currentRoom.id);
    }
  });

  const bodyWidth = Math.max(width - 1, 0);

  if (mode === 'room' || mode === 'members') {
    const title = currentRoom?.name ?? '';
    if (mode === 'members') {
      const rowsAvailable = Math.max(height - 3, 1);
      const start = windowStart(memberIndex, members.length, rowsAvailable);
      return (
        <box flexDirection="column" width={width} height={height} overflow="hidden">
          <text flexShrink={0} fg={theme.fg}>
            {layoutRow(title, `${members.length} members`, bodyWidth)}
          </text>
          <text flexShrink={0} fg={theme.border}>
            {'─'.repeat(bodyWidth)}
          </text>
          {members.slice(start, start + rowsAvailable).map((member) => {
            const isCursor = member.id === members[memberIndex]?.id;
            return (
              <text
                key={member.id}
                flexShrink={0}
                fg={isCursor ? theme.fg : theme.dim}
                bg={isCursor ? theme.surface : undefined}
              >
                <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
                {memberRowText(member, width)}
              </text>
            );
          })}
          {members.length === 0 ? <text fg={theme.faint}>No members.</text> : null}
          <text flexShrink={0} fg={theme.faint}>
            Enter open agent session · Esc back
          </text>
        </box>
      );
    }
    return (
      <box flexDirection="column" width={width} height={height} overflow="hidden">
        <text flexShrink={0} fg={theme.fg}>
          {layoutRow(title, currentRoom?.topic ?? '', bodyWidth)}
        </text>
        <text flexShrink={0} fg={theme.border}>
          {'─'.repeat(bodyWidth)}
        </text>
        {messagesLoading && messages.length === 0 ? <Spinner label="loading messages" /> : null}
        {messagesError ? (
          <text flexShrink={0} fg={theme.danger}>
            {layoutRow(messagesError, '', bodyWidth)}
          </text>
        ) : null}
        <scrollbox
          ref={scrollRef}
          focused={focused}
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          contentOptions={{ flexDirection: 'column' }}
        >
          {!messagesLoading && !messagesError && messages.length === 0 ? (
            <text fg={theme.faint}>No messages in this conversation yet.</text>
          ) : null}
          {messages.map((message) => {
            const indent = message.replyTo != null ? '  ' : '';
            return (
              <box key={message.id} flexDirection="column" flexShrink={0}>
                <text fg={message.senderKind === 'session' ? theme.fg : theme.dim}>
                  {`${indent}${message.senderKind === 'session' ? GLYPH.running : GLYPH.stopped} ${message.sender}`}
                  <span fg={theme.faint}>{`  ${relativeAge(message.atMs, now) || ''}`}</span>
                </text>
                <text
                  fg={theme.fg}
                  wrapMode="word"
                  width={Math.max(bodyWidth - indent.length - 2, 8)}
                >
                  {`${indent}  ${message.text}`}
                </text>
              </box>
            );
          })}
        </scrollbox>
        <text flexShrink={0} fg={theme.faint}>
          j/k scroll · Space page · m members · o browser · r refresh · Esc back
        </text>
      </box>
    );
  }

  const rowsAvailable = Math.max(height - 1, 1);
  const start = windowStart(roomIndex, rooms.length, rowsAvailable);
  return (
    <box flexDirection="column" width={width}>
      {rooms.slice(start, start + rowsAvailable).map((room) => {
        const isCursor = room.id === currentRoom?.id;
        return (
          <text
            key={room.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            {roomRowText(room, width)}
          </text>
        );
      })}
      {loading && rooms.length === 0 ? <Spinner label="loading rooms" /> : null}
      {!loading && !errorMessage && rooms.length === 0 ? (
        <text fg={theme.faint}>You are in no rooms yet. An agent or a person adds you.</text>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}
      <text fg={theme.faint}>
        {layoutRow('Enter read · o browser · r refresh · Esc back', '', bodyWidth)}
      </text>
    </box>
  );
}
