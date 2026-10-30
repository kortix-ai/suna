import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import type { RoomConversation, RoomMember, RoomMessage } from '@kortix/sdk';

import { memberRow, messageRow, roomRow, roomWebUrl } from './rooms-screen.tsx';
import {
  type MemberRow,
  type MessageRow,
  type RoomRow,
  RoomsView,
  type RoomsViewProps,
  memberRowText,
  roomRowText,
} from './rooms-view.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const MINUTE = 60_000;
const SIZE = { width: 84, height: 24 };

function rooms(): RoomRow[] {
  return [
    { id: 'r1', name: 'launch', topic: 'Ship day', unread: 3, memberCount: 4, updatedMs: NOW },
    { id: 'r2', name: 'support', topic: '', unread: 0, memberCount: 2, updatedMs: NOW },
  ];
}

function messages(): MessageRow[] {
  return [
    { id: 'm1', seq: 1, sender: 'Ana Silva', senderKind: 'member', text: 'Is the build green?', replyTo: null, atMs: NOW - 10 * MINUTE },
    { id: 'm2', seq: 2, sender: 'kortix (agent)', senderKind: 'session', text: 'Yes, all checks passed.', replyTo: 1, atMs: NOW - 5 * MINUTE },
  ];
}

function members(): MemberRow[] {
  return [
    { id: 'u1', label: 'Ana Silva', kind: 'person', sessionId: null, status: null },
    { id: 's1', label: '3f2a1b9c (kortix)', kind: 'session', sessionId: 'sess-9', status: 'running' },
  ];
}

function props(overrides: Partial<RoomsViewProps> = {}): RoomsViewProps {
  return {
    rooms: rooms(),
    messages: messages(),
    members: members(),
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    messagesLoading: false,
    errorMessage: null,
    messagesError: null,
    onOpenRoom: () => {},
    onOpenSession: () => {},
    onOpenBrowser: () => {},
    onRefresh: () => {},
    onBack: () => {},
    ...overrides,
  };
}

async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

describe('mappers', () => {
  test('roomRow, messageRow and memberRow carry the API fields', () => {
    const room = {
      room_id: 'r9',
      name: 'ops',
      topic: null,
      unread: 2,
      member_count: 5,
      updated_at: '2026-09-17T10:00:00.000Z',
    } as RoomConversation;
    expect(roomRow(room)).toMatchObject({ id: 'r9', topic: '', unread: 2, memberCount: 5 });
    const message = {
      message_id: 'm',
      seq: 7,
      sender_kind: 'session',
      sender_label: 'kortix',
      text: 'hi',
      reply_to_seq: 3,
      created_at: '2026-09-17T10:00:00.000Z',
    } as RoomMessage;
    expect(messageRow(message)).toMatchObject({ seq: 7, senderKind: 'session', replyTo: 3 });
    const member = { member_id: 'k', kind: 'session', session_id: 's', label: 'L', status: 'running' } as RoomMember;
    expect(memberRow(member)).toMatchObject({ sessionId: 's', status: 'running' });
  });

  test('roomWebUrl builds /rooms/<id>', () => {
    expect(roomWebUrl('https://kortix.com/', 'p1', 'r1')).toBe('https://kortix.com/projects/p1/rooms/r1');
  });

  test('row text shows unread and member counts, and the member kind', () => {
    const text = roomRowText(rooms()[0] as RoomRow, 82);
    expect(text.trimEnd().endsWith('3 new · 4 members')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
    expect(memberRowText(members()[1] as MemberRow, 82).trimEnd().endsWith('running')).toBe(true);
    expect(memberRowText(members()[0] as MemberRow, 82).trimEnd().endsWith('person')).toBe(true);
  });
});

describe('<RoomsView/> through the OpenTUI test renderer', () => {
  test('lists the rooms and moves the cursor', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <RoomsView {...props()} />,
      SIZE,
    );
    await flush();
    const marked = () =>
      captureCharFrame()
        .split('\n')
        .find((line) => line.startsWith('▌'))
        ?.trim();
    expect(captureCharFrame()).toContain('launch · Ship day');
    expect(marked()).toContain('launch');
    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(marked()).toContain('support');
    renderer.destroy();
  });

  test('Enter reads the conversation; Esc closes it and tells the host', async () => {
    const asked: Array<string | null> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <RoomsView {...props({ onOpenRoom: (id) => asked.push(id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(asked).toEqual(['r1']);
    const frame = captureCharFrame();
    expect(frame).toContain('Ship day');
    expect(frame).toContain('Ana Silva');
    expect(frame).toContain('Is the build green?');
    expect(frame).toContain('kortix (agent)');
    expect(frame).toContain('Yes, all checks passed.');

    await pressEscape(mockInput);
    await flush();
    expect(asked).toEqual(['r1', null]);
    expect(captureCharFrame()).toContain('support');
    renderer.destroy();
  });

  test('m lists the members; Enter on an agent opens its session, on a person does nothing', async () => {
    const opened: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <RoomsView {...props({ onOpenSession: (id) => opened.push(id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await act(async () => mockInput.pressKey('m'));
    await flush();
    expect(captureCharFrame()).toContain('2 members');
    await act(async () => mockInput.pressEnter());
    expect(opened).toEqual([]);
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressEnter());
    expect(opened).toEqual(['sess-9']);
    renderer.destroy();
  });

  test('o asks the host to open the browser for the selected room', async () => {
    const opened: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <RoomsView {...props({ onOpenBrowser: (room) => opened.push(room.id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressKey('o'));
    expect(opened).toEqual(['r2']);
    renderer.destroy();
  });

  test('loading, error and empty states each say what is happening', async () => {
    const loading = await testRender(<RoomsView {...props({ rooms: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading rooms');
    loading.renderer.destroy();

    const failed = await testRender(
      <RoomsView {...props({ rooms: [], errorMessage: 'HTTP 403: feature_disabled' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403: feature_disabled');
    failed.renderer.destroy();

    const empty = await testRender(<RoomsView {...props({ rooms: [] })} />, SIZE);
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('You are in no rooms yet.');
    empty.renderer.destroy();

    const quiet = await testRender(<RoomsView {...props({ messages: [] })} />, SIZE);
    await quiet.flush();
    await act(async () => quiet.mockInput.pressEnter());
    await quiet.flush();
    expect(quiet.captureCharFrame()).toContain('No messages in this conversation yet.');
    quiet.renderer.destroy();
  });
});
