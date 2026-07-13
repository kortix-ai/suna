import { expect, test } from 'bun:test';
import { backgroundBuildKey, buildLogProviderCandidates } from './builder';

test('background snapshot build dedup is provider-qualified', () => {
  expect(backgroundBuildKey('daytona', 'kortix-default-abc')).not.toBe(
    backgroundBuildKey('e2b', 'kortix-default-abc'),
  );
  expect(backgroundBuildKey('e2b', 'kortix-default-abc')).toBe(
    'e2b:kortix-default-abc',
  );
});

test('new snapshot build logs reconcile only against their recorded provider', () => {
  expect(buildLogProviderCandidates(
    { source: 'background', slug: 'default-warm', provider: 'e2b' },
    ['daytona', 'platinum', 'e2b'],
  )).toEqual(['e2b']);
});

test('historical build logs reconcile against every enabled provider', () => {
  expect(buildLogProviderCandidates(
    { source: 'background', slug: 'default-warm' },
    ['daytona', 'platinum', 'e2b', 'e2b'],
  )).toEqual(['daytona', 'platinum', 'e2b']);
});
