import { describe, expect, test } from 'bun:test';

import {
  RUNTIME_NOT_READY_BUDGET_MS,
  RUNTIME_NOT_READY_STREAK_GAP_MS,
  isRuntimeNotReadyExhausted,
  recordRuntimeNotReady,
} from './runtime-not-ready-budget';

describe('runtime-not-ready retry budget', () => {
  test('the first sighting starts a streak', () => {
    expect(recordRuntimeNotReady(null, 1_000)).toEqual({ since: 1_000, lastSeen: 1_000 });
  });

  test('a sighting inside the gap extends the same streak', () => {
    // The boundary resets every 800ms and remounts on each throw, so a live
    // outage records a sighting well inside the gap.
    const streak = recordRuntimeNotReady({ since: 1_000, lastSeen: 1_000 }, 1_800);
    expect(streak).toEqual({ since: 1_000, lastSeen: 1_800 });
  });

  test('a sighting after the gap starts a new streak', () => {
    // The page rendered normally in between: a later outage gets a full budget.
    const lastSeen = 1_000;
    const now = lastSeen + RUNTIME_NOT_READY_STREAK_GAP_MS + 1;
    expect(recordRuntimeNotReady({ since: 0, lastSeen }, now)).toEqual({ since: now, lastSeen: now });
  });

  test('silent retry continues until the budget is spent', () => {
    const streak = { since: 0, lastSeen: 0 };
    expect(isRuntimeNotReadyExhausted(streak, RUNTIME_NOT_READY_BUDGET_MS - 1)).toBe(false);
    expect(isRuntimeNotReadyExhausted(streak, RUNTIME_NOT_READY_BUDGET_MS)).toBe(true);
  });

  test('the budget outlasts a normal session switch by a wide margin', () => {
    // The throw self-heals within a second or two; the budget only catches a
    // runtime that never comes up.
    expect(RUNTIME_NOT_READY_BUDGET_MS).toBeGreaterThanOrEqual(20_000);
    expect(RUNTIME_NOT_READY_STREAK_GAP_MS).toBeGreaterThan(800);
  });
});
