import { describe, expect, test } from 'bun:test';
import {
  advanceTriggerScheduleSlot,
  initialTriggerScheduleSlot,
  nextTriggerScheduleSlot,
  triggerScheduleJitterMs,
} from './trigger-schedule';

// Regression guard for the 2026-08-26 Platinum outage: 756 projects inherited
// `0 0 3 * * *` from the project starter and fired on the SAME millisecond.
// 779 provisions landed in the 03:00 hour and 654 failed (346 `capacity`),
// while every other hour that day ran 100% healthy at 6-28 provisions.

const DAILY_3AM = {
  type: 'cron' as const,
  enabled: true,
  cron: '0 0 3 * * *',
  runAt: null,
  timezone: 'UTC',
};
const AFTER = new Date('2026-08-26T12:00:00.000Z');
const WINDOW = 1_800_000; // 30 min

describe('cron jitter', () => {
  test('no jitter key → the exact cron instant (unchanged for every legacy caller)', () => {
    expect(nextTriggerScheduleSlot(DAILY_3AM, AFTER)?.toISOString()).toBe(
      '2026-08-27T03:00:00.000Z',
    );
  });

  test('a jitter key offsets the slot inside the window and never before it', () => {
    const slot = nextTriggerScheduleSlot(DAILY_3AM, AFTER, {
      jitterKey: 'project-a:harness-reflector',
      jitterWindowMs: WINDOW,
    });
    const base = Date.parse('2026-08-27T03:00:00.000Z');
    expect(slot).not.toBeNull();
    expect(slot!.getTime()).toBeGreaterThanOrEqual(base);
    expect(slot!.getTime()).toBeLessThan(base + WINDOW);
  });

  test('the offset is deterministic — the catalog and the claim sweep must agree', () => {
    const args = { jitterKey: 'project-a:harness-reflector', jitterWindowMs: WINDOW };
    const fromCatalog = initialTriggerScheduleSlot(DAILY_3AM, AFTER, args);
    const fromSweep = nextTriggerScheduleSlot(DAILY_3AM, AFTER, args);
    expect(fromCatalog?.toISOString()).toBe(fromSweep!.toISOString());
    // …and stable across processes, not just within one call.
    expect(triggerScheduleJitterMs('project-a:harness-reflector', WINDOW)).toBe(
      triggerScheduleJitterMs('project-a:harness-reflector', WINDOW),
    );
  });

  test('766 projects on one cron spread out instead of stacking on one instant', () => {
    const perMinute = new Map<number, number>();
    for (let i = 0; i < 766; i += 1) {
      const slot = nextTriggerScheduleSlot(DAILY_3AM, AFTER, {
        jitterKey: `project-${i}:harness-reflector`,
        jitterWindowMs: WINDOW,
      })!;
      const minute = Math.floor(slot.getTime() / 60_000);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    // 766 over 30 minutes ≈ 26/min. Unjittered this is 766 in one millisecond.
    expect(Math.max(...perMinute.values())).toBeLessThan(60);
    expect(perMinute.size).toBeGreaterThan(25);
  });

  test('the window is capped at a quarter period so short crons stay short', () => {
    const everyFive = { ...DAILY_3AM, cron: '0 */5 * * * *' };
    for (const key of ['a:t', 'b:t', 'c:t', 'd:t', 'e:t']) {
      const slot = nextTriggerScheduleSlot(everyFive, AFTER, {
        jitterKey: key,
        jitterWindowMs: WINDOW,
      })!;
      // Every 5-minute boundary is a whole multiple of 300_000ms from the epoch,
      // so the remainder IS this trigger's offset from its own boundary.
      expect(slot.getTime() % 300_000).toBeLessThanOrEqual(75_000);
      // A jittered slot is ALWAYS strictly in the future — base is resolved from
      // `after - jitter`, so `base + jitter` can never land at or before `after`.
      expect(slot.getTime()).toBeGreaterThan(AFTER.getTime());
    }
  });

  test('a zero window disables jitter entirely', () => {
    expect(
      nextTriggerScheduleSlot(DAILY_3AM, AFTER, {
        jitterKey: 'project-a:harness-reflector',
        jitterWindowMs: 0,
      })?.toISOString(),
    ).toBe('2026-08-27T03:00:00.000Z');
  });

  test('advancing past a jittered slot lands on the NEXT day, never the same one', () => {
    const args = { jitterKey: 'project-a:harness-reflector', jitterWindowMs: WINDOW };
    const first = nextTriggerScheduleSlot(DAILY_3AM, AFTER, args)!;
    const second = advanceTriggerScheduleSlot(DAILY_3AM, first, args)!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(second.getTime() - first.getTime()).toBe(86_400_000);
  });

  test('a one-off runAt trigger is never jittered', () => {
    const oneOff = { ...DAILY_3AM, cron: null, runAt: '2026-08-27T09:00:00.000Z' };
    expect(
      nextTriggerScheduleSlot(oneOff, AFTER, { jitterKey: 'p:s' })?.toISOString(),
    ).toBe('2026-08-27T09:00:00.000Z');
  });
});
