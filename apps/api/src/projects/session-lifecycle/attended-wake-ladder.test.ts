import { describe, expect, test } from 'bun:test';
import {
  WAKE_ESCALATION_COOLDOWN_MS,
  WAKE_MAX_RESTARTS,
  WAKE_NO_PROGRESS_MS,
  nextWakeLadderStep,
  type WakeLadderBudget,
} from './attended-wake-ladder';

const fresh: WakeLadderBudget = { retried: false, restarts: 0, lastActionMs: null };

describe('nextWakeLadderStep', () => {
  test('a wake that shows progress is never escalated, however long it takes', () => {
    expect(nextWakeLadderStep({ silentMs: WAKE_NO_PROGRESS_MS - 1, serverGaveUp: false, nowMs: 1e9 }, fresh)).toBe('none');
  });

  test('75 s of silence re-drives the start first, then restarts, then gives up', () => {
    const now = 1e9;
    const silent = { silentMs: WAKE_NO_PROGRESS_MS, serverGaveUp: false, nowMs: now };
    expect(nextWakeLadderStep(silent, fresh)).toBe('retry-start');
    expect(nextWakeLadderStep(silent, { retried: true, restarts: 0, lastActionMs: now - WAKE_ESCALATION_COOLDOWN_MS })).toBe('restart');
    expect(
      nextWakeLadderStep(silent, { retried: true, restarts: WAKE_MAX_RESTARTS - 1, lastActionMs: now - WAKE_ESCALATION_COOLDOWN_MS }),
    ).toBe('restart');
    expect(
      nextWakeLadderStep(silent, { retried: true, restarts: WAKE_MAX_RESTARTS, lastActionMs: now - WAKE_ESCALATION_COOLDOWN_MS }),
    ).toBe('exhausted');
  });

  test('a server that gave up skips the silence window but not the cooldown', () => {
    const now = 1e9;
    expect(nextWakeLadderStep({ silentMs: 0, serverGaveUp: true, nowMs: now }, fresh)).toBe('retry-start');
    expect(
      nextWakeLadderStep({ silentMs: 0, serverGaveUp: true, nowMs: now }, { retried: true, restarts: 0, lastActionMs: now - 1_000 }),
    ).toBe('none');
  });
});
