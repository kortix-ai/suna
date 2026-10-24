import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';

import {
  buildSpaceTimeline,
  dayKind,
  gutterTime,
  lastReplyLabel,
  spaceRoster,
  spaceTabFromParam,
  threadIsWorking,
  threadMessageText,
} from './space-timeline';

/** Local wall-clock time, so the day grouping is the same in every time zone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

function thread(id: string, createdBy: string, createdAt: string, extra: Partial<ProjectSession> = {}) {
  return {
    session_id: id,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt,
    status: 'running',
    first_prompt: null,
    name: null,
    custom_name: null,
    branch_name: '',
    metadata: {},
    ...extra,
  } as unknown as ProjectSession;
}

describe('buildSpaceTimeline', () => {
  test('orders threads oldest first and groups them by local day', () => {
    const days = buildSpaceTimeline([
      thread('c', 'u1', at(20, 9)),
      thread('a', 'u1', at(19, 23, 50)),
      thread('b', 'u2', at(20, 0, 5)),
    ]);
    expect(days.map((day) => day.threads.map((item) => item.session.session_id))).toEqual([['a'], ['b', 'c']]);
    expect(days[1]!.date.getDate()).toBe(20);
  });

  test('collapses a thread from the same author within 5 minutes of the previous one', () => {
    const [day] = buildSpaceTimeline([
      thread('a', 'u1', at(20, 10, 0)),
      thread('b', 'u1', at(20, 10, 4)),
      thread('c', 'u1', at(20, 10, 9)),
      thread('d', 'u2', at(20, 10, 10)),
      thread('e', 'u1', at(20, 10, 11)),
    ]);
    expect(day!.threads.map((item) => item.compact)).toEqual([false, true, false, false, false]);
  });

  test('never collapses across a day boundary or for an unknown author', () => {
    const days = buildSpaceTimeline([
      thread('a', 'u1', at(19, 23, 58)),
      thread('b', 'u1', at(20, 0, 1)),
      thread('c', '', at(20, 0, 2)),
      thread('d', '', at(20, 0, 3)),
    ]);
    expect(days.flatMap((day) => day.threads.map((item) => item.compact))).toEqual([false, false, false, false]);
  });
});

describe('dayKind', () => {
  const now = new Date(2026, 9, 20, 15, 0);
  test('names today, yesterday and older days', () => {
    expect(dayKind(new Date(2026, 9, 20, 0, 1), now)).toBe('today');
    expect(dayKind(new Date(2026, 9, 19, 23, 59), now)).toBe('yesterday');
    expect(dayKind(new Date(2026, 9, 18, 12, 0), now)).toBe('earlier');
  });
});

describe('lastReplyLabel', () => {
  test('reads the last activity relative to now', () => {
    const now = new Date(2026, 9, 20, 15, 0).getTime();
    expect(lastReplyLabel(thread('a', 'u1', at(20, 3), { updated_at: at(20, 3) }), 'en', now)).toBe('12 hours ago');
    expect(lastReplyLabel(thread('a', 'u1', at(20, 14, 58), { updated_at: at(20, 14, 58) }), 'en', now)).toBe(
      '2 minutes ago',
    );
  });
});

describe('threadIsWorking', () => {
  test('is true while a turn runs or the first prompt waits for delivery', () => {
    const idle = { state: 'idle', since: null, turn_token: null, pending_delivery: false } as const;
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { working: { ...idle, state: 'working' } }))).toBe(true);
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { working: { ...idle, pending_delivery: true } }))).toBe(true);
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { status: 'provisioning' }))).toBe(true);
    expect(threadIsWorking(thread('a', 'u1', at(20, 1), { working: idle }))).toBe(false);
  });
});

describe('threadMessageText', () => {
  test('shows the first prompt without its reference blocks', () => {
    const text = 'Summarise @notes.md\n\n<file_ref path="notes.md" name="notes.md" />';
    expect(threadMessageText(thread('a', 'u1', at(20, 1), { first_prompt: text }))).toBe('Summarise @notes.md');
  });

  test('falls back to the thread title when there is no first prompt', () => {
    expect(threadMessageText(thread('a', 'u1', at(20, 1), { name: 'Weekly report' }))).toBe('Weekly report');
  });
});

describe('gutterTime', () => {
  test('drops the day period so the time fits the avatar gutter', () => {
    const afternoon = new Date(2026, 9, 20, 14, 13);
    expect(gutterTime(afternoon, 'en')).toBe('2:13');
    expect(gutterTime(afternoon, 'de')).toBe('14:13');
    expect(gutterTime(afternoon, 'zh')).toMatch(/^1?[0-9]:13$/);
  });
});

describe('spaceRoster', () => {
  test('lists each person who started a thread once, and every agent that answered one', () => {
    const roster = spaceRoster([
      thread('a', 'u1', at(20, 9), { owner_type: 'user', owner_name: 'Ada', agent_name: 'kortix' }),
      thread('b', 'u1', at(20, 10), { owner_type: 'user', owner_name: 'Ada', agent_name: 'writer' }),
      thread('c', 'sa1', at(20, 11), { owner_type: 'service_account', agent_name: 'kortix' }),
      thread('d', 'u2', at(20, 12), { owner_type: 'user', owner_email: 'grace@example.test', agent_name: null }),
    ]);
    expect(roster.people.map((person) => person.id)).toEqual(['u1', 'u2']);
    expect(roster.agents).toEqual(['kortix', 'writer']);
  });

  test("a DM counts its agent before any thread exists", () => {
    expect(spaceRoster([], 'writer')).toEqual({ people: [], agents: ['writer'] });
  });
});

describe('spaceTabFromParam', () => {
  test('reads a tab the space has, and falls back to Chat for anything else', () => {
    expect(spaceTabFromParam('files', 'channel')).toBe('files');
    expect(spaceTabFromParam('links', 'channel')).toBe('links');
    expect(spaceTabFromParam('links', 'dm')).toBe('chat');
    expect(spaceTabFromParam('nope', 'channel')).toBe('chat');
    expect(spaceTabFromParam(null, 'dm')).toBe('chat');
  });
});
