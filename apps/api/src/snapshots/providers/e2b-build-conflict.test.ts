import { describe, expect, test } from 'bun:test';
import { isE2BConcurrentBuildConflict, waitForConcurrentE2BBuild } from './e2b-build-conflict';
import type { ProviderState } from './index';

describe('E2B concurrent build conflict', () => {
  test('matches only the E2B waiting-state conflict', () => {
    expect(isE2BConcurrentBuildConflict(new Error('400: build is not in waiting state'))).toBe(
      true,
    );
    expect(isE2BConcurrentBuildConflict(new Error('400: invalid template'))).toBe(false);
  });

  test('waits for the surviving build to become active', async () => {
    const states: ProviderState[] = ['missing', 'building', 'active'];
    let sleeps = 0;

    await waitForConcurrentE2BBuild(async () => states.shift() ?? 'active', {
      timeoutMs: 1_000,
      pollMs: 1,
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(sleeps).toBe(2);
  });

  test('rejects a failed surviving build', async () => {
    await expect(
      waitForConcurrentE2BBuild(async () => 'build_failed', {
        timeoutMs: 1_000,
        pollMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow('Concurrent E2B build settled as build_failed');
  });
});
