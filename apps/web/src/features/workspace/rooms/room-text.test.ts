import { describe, expect, test } from 'bun:test';
import type { RoomMessage } from '@kortix/sdk';

import { activeMention, groupMessages, parseSessionLabel, relativeTime, sessionDisplay, splitMessageText } from './room-text';

const SESSION = 'aaaabbbb-1111-2222-3333-444455556666';
const USER = 'ccccdddd-1111-2222-3333-444455556666';

function message(seq: number, at: string, sender: 'a' | 'b'): RoomMessage {
  return {
    message_id: `m${seq}`,
    room_id: 'r',
    seq,
    sender_kind: 'member',
    sender_user_id: sender,
    sender_session_id: null,
    sender_label: sender,
    text: 'x',
    reply_to_seq: null,
    reply_count: 0,
    last_reply_at: null,
    created_at: at,
  };
}

describe('parseSessionLabel', () => {
  test('reads the short id, agent and title', () => {
    expect(parseSessionLabel('aaaabbbb (builder) "Fix CI"')).toEqual({ shortId: 'aaaabbbb', agent: 'builder', title: 'Fix CI' });
    expect(parseSessionLabel('aaaabbbb "Fix CI"')).toEqual({ shortId: 'aaaabbbb', agent: null, title: 'Fix CI' });
    expect(sessionDisplay('aaaabbbb')).toEqual({ name: 'aaaabbbb', detail: null });
    expect(sessionDisplay('aaaabbbb (builder) "Fix CI"')).toEqual({ name: 'Fix CI', detail: 'builder' });
    expect(sessionDisplay('aaaabbbb (builder)')).toEqual({ name: 'builder', detail: null });
  });
});

describe('groupMessages', () => {
  test('groups one sender within 5 minutes and splits days and senders', () => {
    const days = groupMessages([
      message(1, '2026-10-20T10:00:00', 'a'),
      message(2, '2026-10-20T10:04:00', 'a'),
      message(3, '2026-10-20T10:10:00', 'a'),
      message(4, '2026-10-20T10:11:00', 'b'),
      message(5, '2026-10-21T10:11:30', 'b'),
    ]);
    expect(days.map((d) => d.items.map((i) => i.continuation))).toEqual([[false, true, false, false], [false]]);
  });
});

describe('splitMessageText', () => {
  const targets = [
    { ids: [SESSION], names: ['builder'], label: 'builder' },
    { ids: [USER], names: ['Ada Lovelace', 'ada@example.test'], label: 'Ada Lovelace', self: true },
  ];

  test('resolves id-prefix, slug and @here mentions; leaves unknown tokens and emails as text', () => {
    const parts = splitMessageText('hi @aaaabbbb and @ada-lovelace, @here @nobody a@b.co', targets);
    expect(parts).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', token: 'aaaabbbb', label: '@builder', self: false, everyone: false },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', token: 'ada-lovelace', label: '@Ada Lovelace', self: true, everyone: false },
      { kind: 'text', text: ', ' },
      { kind: 'mention', token: 'here', label: '@here', self: true, everyone: true },
      { kind: 'text', text: ' @nobody a@b.co' },
    ]);
  });

  test('an email mention resolves; trailing punctuation stays text', () => {
    expect(splitMessageText('ping @ada@example.test, @here.', targets)).toEqual([
      { kind: 'text', text: 'ping ' },
      { kind: 'mention', token: 'ada@example.test', label: '@Ada Lovelace', self: true, everyone: false },
      { kind: 'text', text: ', ' },
      { kind: 'mention', token: 'here', label: '@here', self: true, everyone: true },
      { kind: 'text', text: '.' },
    ]);
  });

  test('a short id prefix does not resolve; links keep their @', () => {
    expect(splitMessageText('@aaaa see https://x.dev/@aaaabbbb.', targets)).toEqual([
      { kind: 'text', text: '@aaaa see ' },
      { kind: 'link', href: 'https://x.dev/@aaaabbbb' },
      { kind: 'text', text: '.' },
    ]);
  });
});

describe('activeMention', () => {
  test('finds the @query before the caret', () => {
    expect(activeMention('hey @bui', 8)).toEqual({ query: 'bui', start: 4 });
    expect(activeMention('@', 1)).toEqual({ query: '', start: 0 });
    expect(activeMention('mail a@b', 8)).toBeNull();
    expect(activeMention('hey @bui there', 14)).toBeNull();
  });
});

describe('relativeTime', () => {
  test('rounds to the largest whole unit', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(relativeTime('2026-10-20T11:55:00Z', now, 'en')).toBe('5 minutes ago');
    expect(relativeTime('2026-10-20T09:00:00Z', now, 'en')).toBe('3 hours ago');
    expect(relativeTime('2026-10-20T11:59:50Z', now, 'en')).toBe('now');
  });
});
