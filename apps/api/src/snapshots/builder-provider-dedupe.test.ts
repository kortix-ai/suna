import { expect, test } from 'bun:test';
import {
  backgroundBuildKey,
  buildLogProviderCandidates,
  shouldReconcileProviderState,
  waitForProviderBuild,
} from './builder';

test('background snapshot build dedup is provider-qualified', () => {
  expect(backgroundBuildKey('daytona', 'kortix-default-abc')).not.toBe(
    backgroundBuildKey('platinum', 'kortix-default-abc'),
  );
  expect(backgroundBuildKey('platinum', 'kortix-default-abc')).toBe(
    'platinum:kortix-default-abc',
  );
});

test('new snapshot build logs reconcile only against their recorded provider', () => {
  expect(buildLogProviderCandidates(
    { source: 'background', slug: 'default-warm', provider: 'platinum' },
    ['platinum', 'daytona'],
  )).toEqual(['platinum']);
});

test('historical and unknown build logs remain unattributed', () => {
  expect(buildLogProviderCandidates(
    { source: 'background', slug: 'default-warm' },
    ['platinum', 'daytona', 'daytona'],
  )).toEqual([]);
  expect(buildLogProviderCandidates(
    { source: 'manual', provider: 'managed' },
    ['platinum', 'daytona'],
  )).toEqual([]);
});

test('project reconciliation never turns an observation outage into a rebuild', () => {
  expect(shouldReconcileProviderState('unknown')).toBe(false);
  expect(shouldReconcileProviderState('active')).toBe(false);
  expect(shouldReconcileProviderState('building')).toBe(false);
  expect(shouldReconcileProviderState('removing')).toBe(false);
  expect(shouldReconcileProviderState('missing')).toBe(true);
  expect(shouldReconcileProviderState('build_failed')).toBe(true);
});

test('a second replica waits for an existing provider build instead of starting a duplicate', async () => {
  const states = ['building', 'building', 'active'] as const;
  let index = 0;
  const result = await waitForProviderBuild(
    { getSnapshotState: async () => states[Math.min(index++, states.length - 1)] },
    'kortix-default-current',
    { timeoutMs: 100, pollMs: 0 },
  );
  expect(result).toBe('active');
});

test('a provider build that never settles remains building and is never duplicated', async () => {
  const result = await waitForProviderBuild(
    { getSnapshotState: async () => 'building' },
    'kortix-default-current',
    { timeoutMs: 0, pollMs: 0 },
  );
  expect(result).toBe('building');
});
