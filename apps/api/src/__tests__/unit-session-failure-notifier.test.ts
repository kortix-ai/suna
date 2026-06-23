import { afterEach, describe, expect, test } from 'bun:test';

import {
  notifySessionProvisioningFailed,
  registerSessionFailureNotifier,
  resetSessionFailureNotifier,
} from '../shared/session-failure-notifier';

afterEach(() => resetSessionFailureNotifier());

describe('session-failure-notifier', () => {
  test('no registered notifier → no-op (never throws)', () => {
    expect(() => notifySessionProvisioningFailed('s1', 'boom')).not.toThrow();
  });

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

  test('a rejecting async notifier is swallowed', async () => {
    registerSessionFailureNotifier(async () => {
      throw new Error('async relay exploded');
    });
    expect(() => notifySessionProvisioningFailed('s1', 'x')).not.toThrow();
    // let the rejected microtask settle — the .catch in notify swallows it
    await new Promise((r) => setTimeout(r, 5));
  });
});
