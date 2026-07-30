import { describe, expect, test } from 'bun:test';
import type { MessageWithParts, Turn, TurnCostInfo } from '@/ui';
import {
  sessionTurnDurationMs,
  sessionTurnEndedAt,
  sessionTurnMetaRows,
  sessionTurnSpan,
} from './session-turn-meta-rows';

function userMessage(created?: number): MessageWithParts {
  return { info: { role: 'user', time: { created } }, parts: [] } as unknown as MessageWithParts;
}

function assistantMessage(time: { created?: number; completed?: number }): MessageWithParts {
  return { info: { role: 'assistant', time }, parts: [] } as unknown as MessageWithParts;
}

function turn(user: MessageWithParts, assistantMessages: MessageWithParts[] = []): Turn {
  return { userMessage: user, assistantMessages };
}

const NOW = 1_000_000;

describe('sessionTurnSpan', () => {
  test('reads startedAt from the user message and prefers the last assistant message completed over created', () => {
    const t = turn(userMessage(1_000), [
      assistantMessage({ created: 1_500, completed: 1_800 }),
      assistantMessage({ created: 2_000, completed: 2_500 }),
    ]);
    expect(sessionTurnSpan(t)).toEqual({ startedAt: 1_000, endedAt: 2_500 });
  });

  test('falls back to the last assistant message created when completed is absent', () => {
    const t = turn(userMessage(1_000), [assistantMessage({ created: 1_700 })]);
    expect(sessionTurnSpan(t)).toEqual({ startedAt: 1_000, endedAt: 1_700 });
  });

  test('an empty assistantMessages array yields endedAt: null', () => {
    const t = turn(userMessage(1_000), []);
    expect(sessionTurnSpan(t)).toEqual({ startedAt: 1_000, endedAt: null });
  });
});

describe('sessionTurnEndedAt / sessionTurnDurationMs', () => {
  test('a turn with only one timestamp has an endedAt but no duration', () => {
    const t = turn(userMessage(1_000), [assistantMessage({ created: 1_000 })]);
    expect(sessionTurnEndedAt(t)).toBe(1_000);
    expect(sessionTurnDurationMs(t)).toBeNull();
  });

  test('returns null when endedAt equals startedAt, and when endedAt is before startedAt', () => {
    const equal = turn(userMessage(1_000), [assistantMessage({ created: 1_000 })]);
    expect(sessionTurnDurationMs(equal)).toBeNull();

    const backwards = turn(userMessage(2_000), [assistantMessage({ created: 1_000 })]);
    expect(sessionTurnDurationMs(backwards)).toBeNull();
  });

  test('returns the elapsed ms for a genuine span', () => {
    const t = turn(userMessage(1_000), [assistantMessage({ created: 1_500, completed: 4_000 })]);
    expect(sessionTurnDurationMs(t)).toBe(3_000);
  });
});

describe('sessionTurnMetaRows', () => {
  const fullCost: TurnCostInfo = {
    cost: 0.42,
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };

  test('emits all four rows, in order, for a fully populated turn', () => {
    const rows = sessionTurnMetaRows({
      endedAt: NOW - 5_000,
      now: NOW,
      durationMs: 3_000,
      cost: fullCost,
    });
    expect(rows.map((r) => r.label)).toEqual(['Finished', 'Duration', 'Cost', 'Tokens']);
    expect(rows).toEqual([
      { label: 'Finished', value: '5 seconds ago' },
      { label: 'Duration', value: '3s' },
      { label: 'Cost', value: '$0.42' },
      { label: 'Tokens', value: '150' },
    ]);
  });

  test('omits Cost when cost.cost is 0, and omits Tokens when input + output is 0', () => {
    const rows = sessionTurnMetaRows({
      endedAt: NOW - 5_000,
      now: NOW,
      durationMs: 3_000,
      cost: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    });
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain('Cost');
    expect(labels).not.toContain('Tokens');
  });

  test('omits Duration for a sub-second durationMs, because formatDuration returns an empty string', () => {
    const rows = sessionTurnMetaRows({
      endedAt: NOW - 5_000,
      now: NOW,
      durationMs: 400,
      cost: null,
    });
    expect(rows.map((r) => r.label)).not.toContain('Duration');
  });

  test('returns [] when endedAt, durationMs and cost are all absent', () => {
    expect(sessionTurnMetaRows({ endedAt: null, now: NOW, durationMs: null, cost: null })).toEqual(
      [],
    );
  });

  test('the Finished value is derived from the injected now, not the wall clock', () => {
    const rows = sessionTurnMetaRows({
      endedAt: NOW - 120_000,
      now: NOW,
      durationMs: null,
      cost: null,
    });
    expect(rows[0]?.value).toContain('2 minutes ago');
  });
});
