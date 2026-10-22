import { describe, expect, test } from 'bun:test';
import { keepStoppedRefusesWake } from './resume-stopped-sandbox';

describe('keepStoppedRefusesWake — a keep-alive poll never undoes a deliberate stop', () => {
  const row = (stopReason?: string) => ({ metadata: stopReason ? { stopReason } : {} });

  test('an ordinary open (no keep_stopped) always wakes', () => {
    for (const r of ['manual', 'deadline_expired', 'provider_reconcile', undefined]) {
      expect(keepStoppedRefusesWake(false, row(r))).toBe(false);
    }
  });

  test('a keep-alive poll leaves every stop Kortix or the user chose stopped', () => {
    for (const r of ['manual', 'deadline_expired', 'run_cap', 'idle_grace', 'boot_floor_expired', 'wedged_backlog_remediation']) {
      expect(keepStoppedRefusesWake(true, row(r))).toBe(true);
    }
  });

  test('a keep-alive poll still wakes a box the provider parked, and a row with no reason', () => {
    expect(keepStoppedRefusesWake(true, row('provider_reconcile'))).toBe(false);
    expect(keepStoppedRefusesWake(true, row(undefined))).toBe(false);
    expect(keepStoppedRefusesWake(true, { metadata: null })).toBe(false);
  });
});
