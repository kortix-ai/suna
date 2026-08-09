// The stop vocabulary is CLOSED. A downstream classification query groups on
// it, and a free-text reason makes that query silently incomplete rather than
// loudly wrong.
import { describe, expect, test } from 'bun:test';
import { STOP_REASONS, STOP_REASONS_NOT_YET_EMITTED, isStopReason } from './stop-reason';

describe('STOP_REASONS', () => {
  test('covers every park path the reaper and request path can take', () => {
    // Cast to string[]: `toEqual`'s overload pins the expected side to the
    // exact literal union, so a plain string-literal array on the right does
    // not unify with it without this — the values checked are unchanged.
    expect(([...STOP_REASONS] as string[]).sort()).toEqual(
      [
        'boot_floor_expired',
        'deadline_expired',
        'idle_grace',
        'manual',
        'provider_reconcile',
        'provider_removed',
        'provisioning_stalled',
        'restart_failed',
        'run_cap',
        'runtime_boot_failed',
        'runtime_wake_failed',
        'unusable_runtime_state',
        'wedged_backlog_remediation',
      ].sort(),
    );
  });

  test('rejects anything outside the union', () => {
    expect(isStopReason('deadline_expired')).toBe(true);
    expect(isStopReason('whatever')).toBe(false);
  });
});

// A member nobody writes returns 0 rows, and 0 rows looks exactly like
// "measured, never happens" — the same confident-wrong shape as stamping the
// wrong reason. This list is the machine-readable disclaimer: read it before
// reading a zero.
describe('STOP_REASONS_NOT_YET_EMITTED', () => {
  test('names every member no code path writes today', () => {
    expect(([...STOP_REASONS_NOT_YET_EMITTED] as string[]).sort()).toEqual(
      ['boot_floor_expired', 'idle_grace'].sort(),
    );
  });

  test('is a subset of the vocabulary — never a name the union dropped', () => {
    for (const reason of STOP_REASONS_NOT_YET_EMITTED) {
      expect(isStopReason(reason)).toBe(true);
    }
  });
});
