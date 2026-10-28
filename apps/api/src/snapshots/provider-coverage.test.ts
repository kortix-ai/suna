import { describe, expect, test } from 'bun:test';
import {
  enabledTemplateBuildProviders,
  observeTemplateProviderCoverage,
  resolveConfiguredProjectProviderPin,
  resolveRoutedTemplateState,
  SANDBOX_TEMPLATE_PROVIDERS,
} from './provider-coverage';

describe('sandbox template provider coverage', () => {
  test('every canonical provider is registered as a template-build provider (parity guard)', () => {
    // Extends automatically as SANDBOX_TEMPLATE_PROVIDERS grows — adding a
    // provider without wiring it in here fails loudly instead of silently
    // under-covering it.
    expect(SANDBOX_TEMPLATE_PROVIDERS).toEqual(['platinum']);
  });

  test('builds only on an enabled, allowed provider; removed providers never build', () => {
    expect(enabledTemplateBuildProviders({
      allowed: ['platinum'],
      isEnabled: () => true,
    })).toEqual(['platinum']);
    expect(enabledTemplateBuildProviders({
      allowed: ['platinum'],
      isEnabled: () => false,
    })).toEqual([]);
    // Legacy `e2b` and `daytona` entries are never build providers: their support is removed.
    expect(enabledTemplateBuildProviders({
      allowed: ['platinum', 'e2b', 'daytona'],
      isEnabled: () => true,
    })).toEqual(['platinum']);
  });

  test('observes the current image on Platinum', async () => {
    const calls: string[] = [];
    const result = await observeTemplateProviderCoverage('kortix-default-current', {
      isProviderEnabled: () => true,
      getProvider: (provider) => ({
        getSnapshotState: async (snapshotName: string) => {
          calls.push(`${provider}:${snapshotName}`);
          return 'building';
        },
      }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(calls).toEqual(['platinum:kortix-default-current']);
    expect(result.map(({ provider, status, launch_ready }) => ({ provider, status, launch_ready })))
      .toEqual([{ provider: 'platinum', status: 'building', launch_ready: false }]);
  });

  test.each(['missing', 'building', 'unknown', 'build_failed', 'removing'] as const)(
    'Automatic and a Platinum pin both report the Platinum state %s', (state) => {
      const coverage = [{ provider: 'platinum', available: true, state }] as const;
      expect(resolveRoutedTemplateState(coverage, null)).toBe(state);
      expect(resolveRoutedTemplateState(coverage, 'platinum')).toBe(state);
    },
  );

  test('a disabled provider is unavailable and Automatic reads missing', async () => {
    const result = await observeTemplateProviderCoverage('snapshot', {
      isProviderEnabled: () => false,
      getProvider: () => ({ getSnapshotState: async () => 'active' }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(result.find((item) => item.provider === 'platinum')).toMatchObject({
      available: false,
      status: 'unavailable',
      observed_at: null,
    });
    expect(resolveRoutedTemplateState(result, null)).toBe('missing');
    expect(resolveRoutedTemplateState(result, 'platinum')).toBe('unknown');
  });

  test('provider probe failures stay unknown rather than claiming not built', async () => {
    const result = await observeTemplateProviderCoverage('snapshot', {
      isProviderEnabled: () => true,
      getProvider: () => ({ getSnapshotState: async () => { throw new Error('timeout'); } }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(result.every((item) => item.status === 'unknown')).toBe(true);
    expect(result.every((item) => item.state === null)).toBe(true);
  });

  test('bounds a hung provider observation and reports unknown', async () => {
    const result = await observeTemplateProviderCoverage('snapshot', {
      isProviderEnabled: () => true,
      getProvider: () => ({ getSnapshotState: () => new Promise(() => {}) }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
      observationTimeoutMs: 5,
    });

    expect(result.find((item) => item.provider === 'platinum')).toMatchObject({
      status: 'unknown',
      state: null,
      launch_ready: false,
    });
  });

  test('a removed-provider pin reads as no pin', () => {
    expect(resolveConfiguredProjectProviderPin({ default_sandbox_provider: 'platinum' }))
      .toBe('platinum');
    expect(resolveConfiguredProjectProviderPin({ default_sandbox_provider: 'managed' }))
      .toBeNull();
    // Legacy `e2b` and `daytona` pins are no longer valid: their support is removed.
    expect(resolveConfiguredProjectProviderPin({ default_sandbox_provider: 'e2b' }))
      .toBeNull();
    expect(resolveConfiguredProjectProviderPin({ default_sandbox_provider: 'daytona' }))
      .toBeNull();
  });
});
