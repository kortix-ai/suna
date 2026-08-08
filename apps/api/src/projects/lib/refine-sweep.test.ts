import { describe, expect, test } from 'bun:test';

import type { RefineSpec } from '../refine';
import { buildRefinePrompt, decideRefineFire, parseRefineSessionState } from './refine-sweep';

const spec: RefineSpec = {
  enabled: true,
  everyTurns: 5,
  warmupTurns: 3,
  maxPerSessionPerDay: 2,
  agents: ['kortix'],
};

const now = new Date('2026-08-08T12:00:00.000Z');

function turns(count: number, startMinute = 0): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 7, 8, 10, startMinute + i)).toISOString(),
  );
}

const freshState = parseRefineSessionState({});

describe('parseRefineSessionState', () => {
  test('empty/absent/garbage metadata → zero state', () => {
    for (const metadata of [{}, null, undefined, { refine: 'nope' }, { refine: [1] }]) {
      expect(parseRefineSessionState(metadata)).toEqual({
        marker: null,
        day: null,
        count: 0,
        total: 0,
        last_fired_at: null,
      });
    }
  });

  test('round-trips a stored state', () => {
    const state = {
      marker: '2026-08-08T10:00:00.000Z',
      day: '2026-08-08',
      count: 1,
      total: 4,
      last_fired_at: '2026-08-08T10:05:00.000Z',
    };
    expect(parseRefineSessionState({ refine: state })).toEqual(state);
  });
});

describe('decideRefineFire', () => {
  test('no assistant turns → never fires', () => {
    const d = decideRefineFire({ spec, state: freshState, assistantCreated: [], now });
    expect(d).toEqual({ fire: false, reason: 'no_assistant_turns', marker: null, newTurns: 0 });
  });

  test('first fire waits out warmup + one full cadence window', () => {
    const below = decideRefineFire({
      spec,
      state: freshState,
      assistantCreated: turns(spec.warmupTurns + spec.everyTurns - 1),
      now,
    });
    expect(below.fire).toBe(false);
    expect(below.reason).toBe('warmup');

    const window = turns(spec.warmupTurns + spec.everyTurns);
    const at = decideRefineFire({ spec, state: freshState, assistantCreated: window, now });
    expect(at.fire).toBe(true);
    expect(at.marker).toBe(window[window.length - 1]);
  });

  test('subsequent fires need every_turns past the watermark', () => {
    const all = turns(12);
    const state = { ...freshState, marker: all[7] };
    const under = decideRefineFire({ spec, state, assistantCreated: all, now });
    expect(under.fire).toBe(false);
    expect(under.reason).toBe('below_cadence');
    expect(under.newTurns).toBe(4);

    const enough = turns(13);
    const due = decideRefineFire({
      spec,
      state: { ...freshState, marker: enough[7] },
      assistantCreated: enough,
      now,
    });
    expect(due.fire).toBe(true);
    expect(due.newTurns).toBe(5);
    expect(due.marker).toBe(enough[enough.length - 1]);
  });

  test('daily cap blocks even a due window on the same UTC day', () => {
    const all = turns(20);
    const capped = decideRefineFire({
      spec,
      state: { marker: all[5], day: '2026-08-08', count: 2, total: 2, last_fired_at: null },
      assistantCreated: all,
      now,
    });
    expect(capped.fire).toBe(false);
    expect(capped.reason).toBe('daily_cap');
  });

  test('daily cap resets on a new UTC day', () => {
    const all = turns(20);
    const nextDay = decideRefineFire({
      spec,
      state: { marker: all[5], day: '2026-08-07', count: 2, total: 2, last_fired_at: null },
      assistantCreated: all,
      now,
    });
    expect(nextDay.fire).toBe(true);
  });
});

describe('buildRefinePrompt', () => {
  test('names the skill and instructs to resume the task', () => {
    const prompt = buildRefinePrompt({ spec, newTurns: 7 });
    expect(prompt).toContain('kortix-harness-refinement');
    expect(prompt).toContain('~7 turns');
    expect(prompt).toContain('Resume your task');
    expect(prompt).toContain('no-op is a valid outcome');
  });
});
