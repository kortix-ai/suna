import { STOP_REASONS, type StopReason } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { stopReasonCopy } from './stop-reason-copy';

describe('stopReasonCopy', () => {
  test('every member of the catalogue has copy', () => {
    // The point of the closed union: a reason the server can serialize but the
    // UI cannot explain puts the user back at an unexplained "stopped".
    for (const reason of STOP_REASONS) {
      const copy = stopReasonCopy(reason);
      expect(copy, reason).not.toBeNull();
      expect(copy?.title.length, reason).toBeGreaterThan(0);
      expect(copy?.message.length, reason).toBeGreaterThan(0);
    }
  });

  test('no reason is left with the generic wording it replaced', () => {
    for (const reason of STOP_REASONS) {
      expect(stopReasonCopy(reason)?.title.toLowerCase(), reason).not.toBe('session is stopped');
    }
  });

  test('titles are distinct enough to tell two stops apart', () => {
    // Two different reasons rendering identical copy would be the old
    // behaviour wearing a new field.
    const titles = STOP_REASONS.map((r) => stopReasonCopy(r)?.title);
    expect(new Set(titles).size).toBeGreaterThanOrEqual(STOP_REASONS.length - 1);
  });

  test('a removed computer is the one stop that does not invite a retry', () => {
    // It is the only member the server marks non-retriable; copy that told the
    // user to restart would send them into a 409 loop.
    expect(stopReasonCopy('provider_removed')?.restartLikelyHelps).toBe(false);
    for (const reason of STOP_REASONS.filter((r) => r !== 'provider_removed')) {
      expect(stopReasonCopy(reason)?.restartLikelyHelps, reason).toBe(true);
    }
  });

  test('the boot-failure copy blames the runtime, not the provider', () => {
    // Incident 2026-08-14: a dead tunnel was reported as the provider losing a
    // sandbox. The words for this member must not repeat that.
    const copy = stopReasonCopy('runtime_boot_failed');
    expect(copy?.message).not.toContain('provider');
    expect(copy?.message.toLowerCase()).toContain('reachable');
  });

  test('absence yields no copy, so callers keep their generic card', () => {
    expect(stopReasonCopy(null)).toBeNull();
    expect(stopReasonCopy(undefined)).toBeNull();
  });

  test('a reason outside the catalogue does not throw', () => {
    // The server validates before serializing, but a hand-rolled fetch or an
    // older cached payload can still put anything here.
    expect(stopReasonCopy('not_a_reason' as StopReason)).toBeNull();
  });
});
