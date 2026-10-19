import { testUiTranslator } from '../test-utils/intl';
import type { TurnCostInfo } from '../shared/ui';
import type { SessionLogMessage, SessionLogTurn } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  sessionTurnDurationMs,
  sessionTurnEndedAt,
  sessionTurnMetaRows,
  sessionTurnSpan,
} from './session-turn-meta-rows';

const iso = (ms: number | undefined) => (ms === undefined ? '' : new Date(ms).toISOString());

function userMessage(created?: number): SessionLogMessage {
  return { role: 'user', created_at: iso(created), completed_at: null } as SessionLogMessage;
}

function assistantMessage(time: { created?: number; completed?: number }): SessionLogMessage {
  return {
    role: 'assistant',
    created_at: iso(time.created),
    completed_at: time.completed === undefined ? null : iso(time.completed),
  } as SessionLogMessage;
}

function turn(user: SessionLogMessage, assistant: SessionLogMessage[] = []): Pick<SessionLogTurn, 'user' | 'assistant'> {
  return { user, assistant };
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

  test('a turn with no reply yields endedAt: null', () => {
    const t = turn(userMessage(1_000), []);
    expect(sessionTurnSpan(t)).toEqual({ startedAt: 1_000, endedAt: null });
  });
});

describe('sessionTurnEndedAt / sessionTurnDurationMs', () => {
  test('a turn with only one timestamp has an endedAt but no duration', () => {
    // startedAt is absent (no user `created`) — distinct from the next test's
    // `endedAt <= startedAt` guard, which needs BOTH timestamps present.
    const t = turn(userMessage(), [assistantMessage({ created: 1_700 })]);
    expect(sessionTurnEndedAt(t)).toBe(1_700);
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
    const rows = sessionTurnMetaRows(
      {
        endedAt: NOW - 5_000,
        now: NOW,
        durationMs: 3_000,
        cost: fullCost,
      },
      testUiTranslator,
    );
    expect(rows.map((r) => r.label)).toEqual(['Finished', 'Duration', 'Cost (credits)', 'Tokens']);
    expect(rows).toEqual([
      { label: 'Finished', value: '5 seconds ago' },
      { label: 'Duration', value: '3s' },
      { label: 'Cost (credits)', value: '42' },
      { label: 'Tokens', value: '150' },
    ]);
  });

  test('omits Cost when cost.cost is 0, and omits Tokens when input + output is 0', () => {
    const rows = sessionTurnMetaRows(
      {
        endedAt: NOW - 5_000,
        now: NOW,
        durationMs: 3_000,
        cost: {
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
      testUiTranslator,
    );
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain('Cost (credits)');
    expect(labels).not.toContain('Tokens');
  });

  test('omits Tokens when only reasoning/cache fields are nonzero — the row sums input + output only', () => {
    const rows = sessionTurnMetaRows(
      {
        endedAt: NOW - 5_000,
        now: NOW,
        durationMs: 3_000,
        cost: {
          cost: 0.1,
          tokens: { input: 0, output: 0, reasoning: 5_000, cacheRead: 5_000, cacheWrite: 0 },
        },
      },
      testUiTranslator,
    );
    expect(rows.map((r) => r.label)).not.toContain('Tokens');
  });

  test('omits Duration for a sub-second durationMs, because formatDuration returns an empty string', () => {
    const rows = sessionTurnMetaRows(
      {
        endedAt: NOW - 5_000,
        now: NOW,
        durationMs: 400,
        cost: null,
      },
      testUiTranslator,
    );
    expect(rows.map((r) => r.label)).not.toContain('Duration');
  });

  test('returns [] when endedAt, durationMs and cost are all absent', () => {
    expect(
      sessionTurnMetaRows(
        { endedAt: null, now: NOW, durationMs: null, cost: null },
        testUiTranslator,
      ),
    ).toEqual([]);
  });

  test('the Finished value is derived from the injected now, not the wall clock', () => {
    const rows = sessionTurnMetaRows(
      {
        endedAt: NOW - 120_000,
        now: NOW,
        durationMs: null,
        cost: null,
      },
      testUiTranslator,
    );
    expect(rows[0]?.value).toContain('2 minutes ago');
  });
});

describe('sessionTurnMetaRows — the model that answered', () => {
  const tokens = { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const rowsOf = (input: Partial<Parameters<typeof sessionTurnMetaRows>[0]>) =>
    sessionTurnMetaRows({ endedAt: NOW - 5_000, now: NOW, durationMs: 3_000, cost: null, ...input }, testUiTranslator);

  // Incident 2026-10-02: a Kortix model answered a turn asked of a ChatGPT
  // model. The transcript priced it at the ChatGPT model: $0.
  test('a fallback turn names the model that answered, the model it replaced, and what Kortix billed', () => {
    expect(
      rowsOf({
        cost: { cost: 0, tokens },
        served: { models: ['GLM 5.3 Flash'], fallbackFrom: 'GPT-6.1 Sol (ChatGPT)', billedCost: 0.75 },
      }),
    ).toEqual([
      { label: 'Finished', value: '5 seconds ago' },
      { label: 'Duration', value: '3s' },
      { label: 'Model', value: 'GLM 5.3 Flash' },
      { label: 'In place of', value: 'GPT-6.1 Sol (ChatGPT)' },
      { label: 'Cost (credits)', value: '75' },
      { label: 'Tokens', value: '150' },
    ]);
  });

  test('a fallback turn never shows the estimate for the model that did not answer', () => {
    const rows = rowsOf({
      cost: { cost: 4.2, tokens },
      served: { models: ['GPT-6.1 Sol (ChatGPT)'], fallbackFrom: 'Claude Sonnet 5.5', billedCost: 0 },
    });
    expect(rows.map((row) => row.label)).toEqual(['Finished', 'Duration', 'Model', 'In place of', 'Tokens']);
  });

  test('a turn its own model answered names the model and keeps the estimate', () => {
    const rows = rowsOf({
      cost: { cost: 0.42, tokens },
      served: { models: ['GLM 5.3 Flash', 'Kimi K3'], fallbackFrom: null, billedCost: 0.4 },
    });
    expect(rows).toContainEqual({ label: 'Model', value: 'GLM 5.3 Flash, Kimi K3' });
    expect(rows).toContainEqual({ label: 'Cost (credits)', value: '42' });
    expect(rows.map((row) => row.label)).not.toContain('In place of');
  });

  test('a turn with no answered request has no Model row', () => {
    expect(rowsOf({ served: { models: [], fallbackFrom: null, billedCost: 0 } }).map((row) => row.label)).toEqual([
      'Finished',
      'Duration',
    ]);
  });
});

