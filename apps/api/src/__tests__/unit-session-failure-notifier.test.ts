import { describe, expect, spyOn, test } from 'bun:test';

import {
  notifySessionProvisioningFailed,
  registerSessionFailureNotifier,
} from '../shared/session-failure-notifier';

// Each test registers its own notifier; registration replaces the previous one.
describe('session-failure-notifier', () => {
  test('forwards sessionId + message to the registered notifier', async () => {
    const seen: Array<{ id: string; msg: string }> = [];
    registerSessionFailureNotifier((id, msg) => seen.push({ id, msg }));
    notifySessionProvisioningFailed('s1', 'at capacity');
    expect(seen).toEqual([{ id: 's1', msg: 'at capacity' }]);
  });

  test('ignores empty sessionId', () => {
    let called = false;
    registerSessionFailureNotifier(() => (called = true));
    notifySessionProvisioningFailed('', 'x');
    expect(called).toBe(false);
  });

  test('a throwing notifier is swallowed (provisioning cleanup must not break)', () => {
    registerSessionFailureNotifier(() => {
      throw new Error('relay exploded');
    });
    expect(() => notifySessionProvisioningFailed('s1', 'x')).not.toThrow();
  });

  // Bun does not fail a test on an unhandled rejection, so "did not throw" is
  // not proof here. The rejection must reach the notifier's own catch.
  test('a rejecting async notifier is caught and logged, not left unhandled', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      registerSessionFailureNotifier(async () => {
        throw new Error('async relay exploded');
      });
      notifySessionProvisioningFailed('s1', 'x');
      await new Promise((r) => setTimeout(r, 5));
      expect(warn).toHaveBeenCalledWith('[session-failure-notifier] relay failed', {
        sessionId: 's1',
        err: 'async relay exploded',
      });
    } finally {
      warn.mockRestore();
    }
  });
});
