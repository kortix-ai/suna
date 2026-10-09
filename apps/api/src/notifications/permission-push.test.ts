// Permission notification gate: the claim decides, the notification is
// fire-and-forget, the ask context goes to the notifier unresolved (it resolves
// it only when the project's notification_center flag is on), and a failure
// never escapes. Injected claim and notifier, no mock.module.
// The cross-replica claim on PostgreSQL: __tests__/integration-permission-push-claim.test.ts.
import { describe, expect, test } from 'bun:test';
import { createPermissionPushGate } from './permission-push';
import type { SessionPushEvent } from './session-push';

const PROJECT = '00000000-0000-4000-8000-000000000001';

/** `flagOn`: the notifier resolves the context, as notifySessionEvent does for a flag-on project. */
function harness(opts: { fail?: boolean; flagOn?: boolean } = {}) {
  const sent: SessionPushEvent[] = [];
  const warnings: unknown[][] = [];
  const claimed = new Set<string>();
  const gate = createPermissionPushGate({
    claim: async (sessionId, requestId) => {
      const key = `${sessionId}\u0000${requestId}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    notify: async (event, options) => {
      const context = (opts.flagOn ?? true) && options.context ? await options.context() : {};
      sent.push({ ...event, ...context });
      if (opts.fail) throw new Error('expo down');
    },
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  });
  return { gate, sent, warnings };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('createPermissionPushGate', () => {
  test('notifies once per claimed request id, carrying the request id', async () => {
    const { gate, sent } = harness();
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(false);
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_2' })).toBe(true);
    await settle();
    expect(sent).toEqual([
      { type: 'permission', sessionId: 's1', projectId: PROJECT, requestId: 'per_1' },
      { type: 'permission', sessionId: 's1', projectId: PROJECT, requestId: 'per_2' },
    ]);
  });

  test('scopes the request id to its session', async () => {
    const { gate, sent } = harness();
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(await gate.notify({ sessionId: 's2', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    await settle();
    expect(sent).toHaveLength(2);
  });

  test('the ask context reaches the notifier only from the call that won the claim', async () => {
    const { gate, sent } = harness();
    let resolved = 0;
    const context = async () => {
      resolved += 1;
      return { prompterUserId: 'user-b', originClass: 'unattended' as const, isChild: false, triggerWatcherIds: ['user-w'] };
    };
    await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1', context });
    await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1', context });
    await settle();
    expect(resolved).toBe(1);
    expect(sent).toEqual([
      {
        type: 'permission',
        sessionId: 's1',
        projectId: PROJECT,
        requestId: 'per_1',
        prompterUserId: 'user-b',
        originClass: 'unattended',
        isChild: false,
        triggerWatcherIds: ['user-w'],
      },
    ]);
  });

  // KRTX-1742 flag off: the creator-only push needs no context, so its
  // recipient queries never run.
  test('the gate itself never resolves the context', async () => {
    const { gate, sent } = harness({ flagOn: false });
    let resolved = 0;
    const context = async () => {
      resolved += 1;
      return { prompterUserId: 'user-b' };
    };
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1', context })).toBe(true);
    await settle();
    expect(resolved).toBe(0);
    expect(sent).toEqual([{ type: 'permission', sessionId: 's1', projectId: PROJECT, requestId: 'per_1' }]);
  });

  test('a dispatcher failure is logged, never thrown', async () => {
    const { gate, warnings } = harness({ fail: true });
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    await settle();
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain('[push] permission notification failed');
  });
});
