import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import {
  notifySessionProvisioningFailed,
  registerSessionFailureNotifier,
} from '../shared/session-failure-notifier';

// Every channel registers its own relay (Slack, Teams) and each acts only on its
// own turn row. This held ONE notifier ("last wins") until 2026-09-28, and the
// Slack relay took a Teams turn for its own in a project with both installed.
const registered: Array<() => void> = [];
const register = (fn: (id: string, msg: string) => unknown) => {
  registered.push(registerSessionFailureNotifier(fn));
};

afterEach(() => {
  while (registered.length) registered.pop()!();
});

describe('session-failure-notifier', () => {
  test('forwards sessionId + message to the registered notifier', () => {
    const seen: Array<{ id: string; msg: string }> = [];
    register((id, msg) => seen.push({ id, msg }));
    notifySessionProvisioningFailed('s1', 'at capacity');
    expect(seen).toEqual([{ id: 's1', msg: 'at capacity' }]);
  });

  test('every registered channel hears the failure', () => {
    const seen: string[] = [];
    register(() => seen.push('slack'));
    register(() => seen.push('teams'));
    notifySessionProvisioningFailed('s1', 'x');
    expect(seen.sort()).toEqual(['slack', 'teams']);
  });

  test('registering the same notifier twice calls it once, and unregistering removes it', () => {
    let calls = 0;
    const fn = () => (calls += 1);
    register(fn);
    register(fn);
    notifySessionProvisioningFailed('s1', 'x');
    expect(calls).toBe(1);
    while (registered.length) registered.pop()!();
    notifySessionProvisioningFailed('s1', 'x');
    expect(calls).toBe(1);
  });

  test('ignores empty sessionId', () => {
    let called = false;
    register(() => (called = true));
    notifySessionProvisioningFailed('', 'x');
    expect(called).toBe(false);
  });

  test('a throwing notifier is swallowed and does not stop the next channel', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let reached = false;
      register(() => {
        throw new Error('relay exploded');
      });
      register(() => (reached = true));
      expect(() => notifySessionProvisioningFailed('s1', 'x')).not.toThrow();
      expect(reached).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // Bun does not fail a test on an unhandled rejection, so "did not throw" is
  // not proof here. The rejection must reach the notifier's own catch.
  test('a rejecting async notifier is caught and logged, not left unhandled', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      register(async () => {
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
