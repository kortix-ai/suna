import { describe, expect, test } from 'bun:test';

import type { MessageWithParts, Turn } from '@/lib/opencode/types';
import {
  TURN_META_LABELS,
  formatDistanceStrictAgo,
  turnDurationMs,
  turnEndedAt,
  turnMetaRows,
} from './turn-meta';

function message(
  id: string,
  role: 'user' | 'assistant',
  time: { created?: number; completed?: number } | undefined,
): MessageWithParts {
  return {
    info: { id, role, sessionID: 's1', time } as unknown as MessageWithParts['info'],
    parts: [],
  };
}

function turn(user: MessageWithParts, ...assistants: MessageWithParts[]): Turn {
  return { userMessage: user, assistantMessages: assistants };
}

const cost = (value: number, input: number, output: number) => ({
  cost: value,
  tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
});

describe('turnEndedAt / turnDurationMs — web session-turn-meta-rows.ts', () => {
  test('ends at the last assistant message completed stamp', () => {
    const t = turn(
      message('u', 'user', { created: 1_000 }),
      message('a1', 'assistant', { created: 2_000, completed: 3_000 }),
      message('a2', 'assistant', { created: 4_000, completed: 9_000 }),
    );
    expect(turnEndedAt(t)).toBe(9_000);
    expect(turnDurationMs(t)).toBe(8_000);
  });

  test('falls back to created for an assistant message that never completed', () => {
    const t = turn(message('u', 'user', { created: 1_000 }), message('a', 'assistant', { created: 5_000 }));
    expect(turnEndedAt(t)).toBe(5_000);
    expect(turnDurationMs(t)).toBe(4_000);
  });

  test('no assistant message: no end, no duration', () => {
    const t = turn(message('u', 'user', { created: 1_000 }));
    expect(turnEndedAt(t)).toBeNull();
    expect(turnDurationMs(t)).toBeNull();
  });

  test('a same-instant span is no duration, not 0s', () => {
    const t = turn(
      message('u', 'user', { created: 1_000 }),
      message('a', 'assistant', { created: 1_000, completed: 1_000 }),
    );
    expect(turnDurationMs(t)).toBeNull();
  });
});

describe('formatDistanceStrictAgo — date-fns formatDistanceStrict(date, now, { addSuffix: true }), en-US', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);

  test('seconds', () => {
    expect(formatDistanceStrictAgo(now, now)).toBe('0 seconds ago');
    expect(formatDistanceStrictAgo(now - 1_000, now)).toBe('1 second ago');
    expect(formatDistanceStrictAgo(now - 15_000, now)).toBe('15 seconds ago');
  });

  test('59.7s rounds to 60 seconds, as date-fns does', () => {
    expect(formatDistanceStrictAgo(now - 59_700, now)).toBe('60 seconds ago');
  });

  test('minutes and hours', () => {
    expect(formatDistanceStrictAgo(now - 60_000, now)).toBe('1 minute ago');
    expect(formatDistanceStrictAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatDistanceStrictAgo(now - 3 * 3_600_000, now)).toBe('3 hours ago');
  });

  test('days, months, years', () => {
    expect(formatDistanceStrictAgo(now - 2 * 86_400_000, now)).toBe('2 days ago');
    expect(formatDistanceStrictAgo(now - 60 * 86_400_000, now)).toBe('2 months ago');
    expect(formatDistanceStrictAgo(now - 400 * 86_400_000, now)).toBe('1 year ago');
  });

  test('a future stamp reads "in"', () => {
    expect(formatDistanceStrictAgo(now + 30_000, now)).toBe('in 30 seconds');
  });
});

describe('turnMetaRows — labelled rows in display order', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);

  test('labels are the web popover labels', () => {
    expect(TURN_META_LABELS).toEqual({
      finished: 'Finished',
      duration: 'Duration',
      cost: 'Cost',
      tokens: 'Tokens',
    });
  });

  test('every row present', () => {
    expect(
      turnMetaRows({ endedAt: now - 120_000, now, durationMs: 65_000, cost: cost(0.0321, 1200, 800) }),
    ).toEqual([
      { label: 'Finished', value: '2 minutes ago' },
      { label: 'Duration', value: '1m 5s' },
      { label: 'Cost', value: '$0.03' },
      { label: 'Tokens', value: '2.0k' },
    ]);
  });

  test('a sub-second duration is omitted', () => {
    expect(turnMetaRows({ endedAt: null, now, durationMs: 400, cost: undefined })).toEqual([]);
  });

  test('zero cost and zero tokens are omitted, not rendered as $0.00 / 0', () => {
    expect(turnMetaRows({ endedAt: now, now, durationMs: null, cost: cost(0, 0, 0) })).toEqual([
      { label: 'Finished', value: '0 seconds ago' },
    ]);
  });

  test('tokens are input + output only', () => {
    const heavy = { cost: 0, tokens: { input: 10, output: 5, reasoning: 999, cache: { read: 99_999, write: 1 } } };
    const rows = turnMetaRows({ endedAt: null, now, durationMs: null, cost: heavy });
    expect(rows).toEqual([{ label: 'Tokens', value: '15' }]);
  });
});
