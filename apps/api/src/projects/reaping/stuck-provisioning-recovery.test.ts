import { beforeEach, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';
import * as identity from '../runtime-identity';
import * as verification from './parked-runtime-verification';

const now = new Date('2026-11-02T18:00:00Z');
const row: typeof sessionSandboxes.$inferSelect = {
  sandboxId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'ses_test',
  accountId: '00000000-0000-4000-8000-000000000002',
  projectId: '00000000-0000-4000-8000-000000000003',
  provider: 'platinum', externalId: 'sbx_test', status: 'provisioning',
  baseUrl: null, config: {}, metadata: {}, lastUsedAt: null,
  activeSince: now, deadlineAt: now, createdAt: now,
  updatedAt: new Date(now.getTime() - 60 * 60_000),
};
const claimed = { ...row, metadata: { runtimeIdentityState: 'recovery_claimed' } };
let outcome: verification.ParkedRemovalOutcome;
let events: string[];
let preserved: typeof row | undefined;

mock.module('../../shared/db', () => ({ db: {
  select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({
    orderBy: () => ({ limit: async () => [{ row, sessionMetadata: {} }] }),
  }) }) }) }),
} }));
mock.module('../../platform/providers', () => ({
  getProvider: () => ({ getStatus: async () => 'removed' }),
}));
mock.module('./parked-runtime-verification', () => ({ ...verification,
  recoverRemovedParkedRuntime: async () => {
    events.push('recover');
    return { outcome, row: claimed };
  },
}));
mock.module('../runtime-identity', () => ({ ...identity,
  preserveEstablishedRuntime: async (value: typeof row) => {
    events.push('preserve'); preserved = value; return value;
  },
}));
const { convergeStuckProvisioningRuntimes } = await import('./stuck-provisioning');
beforeEach(() => { outcome = 'recovered'; events = []; preserved = undefined; });

test('a recoverable removed provisioning runtime is not reported lost', async () => {
  const result = await convergeStuckProvisioningRuntimes(now);
  expect(events).toEqual(['recover']);
  expect(result.lost).toBe(0);
});
test('a concurrent recovery owner keeps its runtime', async () => {
  outcome = 'recovery-in-flight';
  const result = await convergeStuckProvisioningRuntimes(now);
  expect(events).toEqual(['recover']);
  expect(result.lost).toBe(0);
});
test('only an unavailable recovery preserves the claimed identity as lost', async () => {
  outcome = 'preserve-lost';
  const result = await convergeStuckProvisioningRuntimes(now);
  expect(events).toEqual(['recover', 'preserve']);
  expect(preserved).toBe(claimed);
  expect(result.lost).toBe(1);
});
