// Permission push dedupe: one push per (session, request id), bounded memory,
// and a dispatcher failure never escapes. Injected notifier, no mock.module.
import { describe, expect, test } from 'bun:test';
import { createPermissionPushGate } from './permission-push';
import type { SessionPushEvent } from './session-push';

const PROJECT = '00000000-0000-4000-8000-000000000001';

function harness(limit?: number, fail = false) {
  const sent: SessionPushEvent[] = [];
  const warnings: unknown[][] = [];
  const gate = createPermissionPushGate({
    limit,
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
  test('sends one permission push per request id', async () => {
    const { gate, sent } = harness();
    expect(gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(false);
    expect(gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_2' })).toBe(true);
    await Promise.resolve();
    expect(sent).toEqual([
      { type: 'permission', sessionId: 's1', projectId: PROJECT },
      { type: 'permission', sessionId: 's1', projectId: PROJECT },
    ]);
  });

  test('scopes the request id to its session', () => {
    const { gate, sent } = harness();
    expect(gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(gate.notify({ sessionId: 's2', projectId: PROJECT, requestId: 'per_1' })).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('evicts the oldest id past the limit; a recent id stays deduped', () => {
    const { gate, sent } = harness(2);
    gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'a' });
    gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'b' });
    gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'c' });
    expect(gate.size()).toBe(2);
    expect(gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'c' })).toBe(false);
    expect(gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'a' })).toBe(true);
    expect(sent).toHaveLength(4);
  });

  test('defaults to a 500-entry bound', () => {
    const { gate } = harness();
    for (let i = 0; i < 600; i++) gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: `per_${i}` });
    expect(gate.size()).toBe(500);
  });

  test('a dispatcher failure is logged, never thrown', async () => {
    const { gate, warnings } = harness(undefined, true);
    expect(() => gate.notify({ sessionId: 's1', projectId: PROJECT, requestId: 'per_1' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain('[push] permission notification failed');
  });
});
