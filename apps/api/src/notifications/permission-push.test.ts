// Permission push gate: the claim decides, the push is fire-and-forget, and a
// dispatcher failure never escapes. Injected claim and notifier, no mock.module.
// The cross-replica claim on PostgreSQL: __tests__/integration-permission-push-claim.test.ts.
import { describe, expect, test } from 'bun:test';
import { createPermissionPushGate } from './permission-push';
import type { SessionPushEvent } from './session-push';

const PROJECT = '00000000-0000-4000-8000-000000000001';

function harness(fail = false) {
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
    notify: async (event) => {
      sent.push(event);
      if (fail) throw new Error('expo down');
      return { sent: 0, reason: 'no_devices' };
    },
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  });
  return { gate, sent, warnings };
}

describe('createPermissionPushGate', () => {
  test('sends one permission push per claimed request id', async () => {
    const { gate, sent } = harness();
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(false);
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_2' })).toBe(true);
    expect(sent).toEqual([
      { type: 'permission', sessionId: 's1', projectId: PROJECT },
      { type: 'permission', sessionId: 's1', projectId: PROJECT },
    ]);
  });

  test('scopes the request id to its session', async () => {
    const { gate, sent } = harness();
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(await gate.notify({ sessionId: 's2', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('a dispatcher failure is logged, never thrown', async () => {
    const { gate, warnings } = harness(true);
    expect(await gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain('[push] permission notification failed');
  });
});
