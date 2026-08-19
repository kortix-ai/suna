import { expect, test } from 'bun:test';
import { resolveWarmBaseImageRef, shouldAttemptWarmFromBase } from './builder';

test('only an active base snapshot is eligible for the FROM-base fast path', () => {
  expect(shouldAttemptWarmFromBase('active')).toBe(true);
  expect(shouldAttemptWarmFromBase('building')).toBe(false);
  expect(shouldAttemptWarmFromBase('missing')).toBe(false);
  expect(shouldAttemptWarmFromBase('build_failed')).toBe(false);
  expect(shouldAttemptWarmFromBase('removing')).toBe(false);
  expect(shouldAttemptWarmFromBase('unknown')).toBe(false);
});

test('resolves the base image ref when the base snapshot is active', async () => {
  const ref = await resolveWarmBaseImageRef(
    {
      getSnapshotState: async () => 'active',
      getSnapshotImageRef: async () => 'registry.example/kortix-default-abc:latest',
    },
    'kortix-default-abc',
  );
  expect(ref).toBe('registry.example/kortix-default-abc:latest');
});

test('never attempts the fast path when the base snapshot is not active', async () => {
  let imageRefCalls = 0;
  const ref = await resolveWarmBaseImageRef(
    {
      getSnapshotState: async () => 'building',
      getSnapshotImageRef: async () => {
        imageRefCalls += 1;
        return 'registry.example/kortix-default-abc:latest';
      },
    },
    'kortix-default-abc',
  );
  expect(ref).toBeUndefined();
  expect(imageRefCalls).toBe(0);
});

test('falls back to undefined when the provider has no getSnapshotImageRef capability', async () => {
  const ref = await resolveWarmBaseImageRef(
    { getSnapshotState: async () => 'active' },
    'kortix-default-abc',
  );
  expect(ref).toBeUndefined();
});

test('falls back to undefined when getSnapshotState rejects', async () => {
  const ref = await resolveWarmBaseImageRef(
    {
      getSnapshotState: async () => {
        throw new Error('network blip');
      },
      getSnapshotImageRef: async () => 'registry.example/kortix-default-abc:latest',
    },
    'kortix-default-abc',
  );
  expect(ref).toBeUndefined();
});

test('falls back to undefined when getSnapshotImageRef rejects', async () => {
  const ref = await resolveWarmBaseImageRef(
    {
      getSnapshotState: async () => 'active',
      getSnapshotImageRef: async () => {
        throw new Error('lookup failed');
      },
    },
    'kortix-default-abc',
  );
  expect(ref).toBeUndefined();
});

test('falls back to undefined when getSnapshotImageRef resolves null', async () => {
  const ref = await resolveWarmBaseImageRef(
    {
      getSnapshotState: async () => 'active',
      getSnapshotImageRef: async () => null,
    },
    'kortix-default-abc',
  );
  expect(ref).toBeUndefined();
});
