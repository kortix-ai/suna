/**
 * `preserveEstablishedRuntimeOnOpen` is UNCHANGED by the admission-replacement
 * work (see `replace-refused-runtime-on-open.test.ts`): admission refusal now
 * calls `replaceRefusedRuntimeOnOpen` instead, and never reaches this helper.
 * This file pins that its other four populations — a stalled provision, a
 * failed wake, a failed boot, and a real provider removal — still park or
 * preserve exactly as before.
 *
 * `runtimeLossVerdict` is the REAL function (not mocked): only its input, the
 * provider status, decides park vs. preserve, exactly as in production.
 */
import type { sessionSandboxes } from '@kortix/db';
import { describe, expect, mock, test } from 'bun:test';
import * as realRuntimeIdentity from '../../services/sandboxes/runtime-identity';

let parkCalls: Array<{ reason: string; stopReason: string }> = [];
let preserveCalls: Array<{ reason: string; stopReason: string }> = [];

mock.module('../../services/sandboxes/runtime-identity', () => ({
  ...realRuntimeIdentity,
  parkEstablishedRuntime: async (
    row: typeof sessionSandboxes.$inferSelect,
    reason: string,
    stopReason: string,
  ) => {
    parkCalls.push({ reason, stopReason });
    return { ...row, status: 'stopped' as const };
  },
  preserveEstablishedRuntime: async (
    row: typeof sessionSandboxes.$inferSelect,
    reason: string,
    stopReason: string,
  ) => {
    preserveCalls.push({ reason, stopReason });
    return { ...row, status: 'stopped' as const };
  },
}));

const { preserveEstablishedRuntimeOnOpen } = await import('./shared');

const ROW = {
  sandboxId: 'sess-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  provider: 'daytona',
  externalId: 'ext-1',
  baseUrl: null,
  status: 'active',
  config: {},
  metadata: {},
  lastUsedAt: null,
  deadlineAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
} as unknown as typeof sessionSandboxes.$inferSelect;

const LOADED = { row: {} as never, userId: 'user-1' };
const VISIBLE = {
  row: { sandboxProvider: 'daytona', baseRef: null, agentName: 'default', metadata: null },
};

const PARKING_POPULATIONS: Array<{ reason: string; stopReason: Parameters<typeof preserveEstablishedRuntimeOnOpen>[6] }> = [
  { reason: 'stale_provisioning_pending', stopReason: 'provisioning_stalled' },
  { reason: 'runtime_wake_timeout', stopReason: 'runtime_wake_failed' },
  { reason: 'opencode_ready_wait_stale', stopReason: 'runtime_boot_failed' },
];

describe('preserveEstablishedRuntimeOnOpen — the four unrelated populations, unchanged', () => {
  test.each(PARKING_POPULATIONS)(
    '$stopReason parks (retriable, box wakeable) when the provider is not definitively removed',
    async ({ reason, stopReason }) => {
      parkCalls = [];
      preserveCalls = [];

      const result = await preserveEstablishedRuntimeOnOpen(
        LOADED,
        VISIBLE,
        'proj-1',
        'sess-1',
        ROW,
        reason,
        stopReason,
        'running',
      );

      expect(parkCalls).toEqual([{ reason, stopReason }]);
      expect(preserveCalls).toEqual([]);
      expect(result.stage).toBe('failed');
      expect(result.retriable).toBe(true);
      expect(result.reason).toBe(reason);
      expect(result.reason).not.toBe(realRuntimeIdentity.RUNTIME_IDENTITY_UNAVAILABLE);
    },
  );

  test('a real provider `removed` still preserves as lost — terminal, RUNTIME_IDENTITY_UNAVAILABLE', async () => {
    parkCalls = [];
    preserveCalls = [];

    const result = await preserveEstablishedRuntimeOnOpen(
      LOADED,
      VISIBLE,
      'proj-1',
      'sess-1',
      ROW,
      'runtime_removed',
      'provider_removed',
      'removed',
    );

    expect(preserveCalls).toEqual([{ reason: 'runtime_removed', stopReason: 'provider_removed' }]);
    expect(parkCalls).toEqual([]);
    expect(result.stage).toBe('failed');
    expect(result.retriable).toBe(false);
    expect(result.reason).toBe(realRuntimeIdentity.RUNTIME_IDENTITY_UNAVAILABLE);
  });
});
