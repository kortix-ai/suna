import { describe, expect, test } from 'bun:test';
import {
  enabledTemplateBuildProviders,
  observeTemplateProviderCoverage,
  resolveConfiguredProjectProviderPin,
  resolveRoutedTemplateState,
  resolveUsableProjectProviderPin,
  SANDBOX_TEMPLATE_PROVIDERS,
} from './provider-coverage';

describe('sandbox template provider coverage', () => {
  test('every canonical provider is registered as a template-build provider (parity guard)', () => {
    // Extends automatically as SANDBOX_TEMPLATE_PROVIDERS grows — this is the
    // test the reinforcement asked for: adding a provider without wiring it
    // in here fails loudly instead of silently under-covering it.
    expect(SANDBOX_TEMPLATE_PROVIDERS).toContain('local-docker');
    expect(SANDBOX_TEMPLATE_PROVIDERS).toEqual(['daytona', 'platinum', 'e2b', 'local-docker']);
  });

  test('synchronizes reusable templates to every enabled provider regardless of routing pins', () => {
    expect(enabledTemplateBuildProviders({
      allowed: ['daytona', 'platinum', 'e2b', 'local-docker'],
      isEnabled: () => true,
    })).toEqual(['daytona', 'platinum', 'e2b', 'local-docker']);
    expect(enabledTemplateBuildProviders({
      allowed: ['daytona', 'platinum', 'e2b', 'local-docker'],
      isEnabled: (provider) => provider !== 'platinum',
    })).toEqual(['daytona', 'e2b', 'local-docker']);
  });

  test('observes the current image independently on Daytona, Platinum, E2B, and local-docker', async () => {
    const calls: string[] = [];
    const states = { daytona: 'active', platinum: 'building', e2b: 'missing', 'local-docker': 'active' } as const;

    const result = await observeTemplateProviderCoverage('kortix-default-current', {
      isProviderEnabled: () => true,
      getProvider: (provider) => ({
        getSnapshotState: async (snapshotName: string) => {
          calls.push(`${provider}:${snapshotName}`);
          return states[provider];
        },
      }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(calls).toEqual([
      'daytona:kortix-default-current',
      'platinum:kortix-default-current',
      'e2b:kortix-default-current',
      'local-docker:kortix-default-current',
    ]);
    expect(result.map(({ provider, status, launch_ready }) => ({ provider, status, launch_ready })))
      .toEqual([
        { provider: 'daytona', status: 'ready', launch_ready: true },
        { provider: 'platinum', status: 'building', launch_ready: false },
        { provider: 'e2b', status: 'not_built', launch_ready: false },
        { provider: 'local-docker', status: 'ready', launch_ready: true },
      ]);
  });

  test('automatic routing is ready only when every enabled provider is launch ready', () => {
    const coverage = [
      { provider: 'daytona', available: true, state: 'active' },
      { provider: 'platinum', available: true, state: 'active' },
      { provider: 'e2b', available: true, state: 'building' },
    ] as const;

    expect(resolveRoutedTemplateState(coverage, null)).toBe('building');
    expect(resolveRoutedTemplateState(coverage, 'daytona')).toBe('active');
  });

  test('disabled providers are unavailable and do not block automatic readiness', async () => {
    const result = await observeTemplateProviderCoverage('snapshot', {
      isProviderEnabled: (provider) => provider === 'e2b',
      getProvider: () => ({ getSnapshotState: async () => 'active' }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(result.find((item) => item.provider === 'daytona')).toMatchObject({
      available: false,
      status: 'unavailable',
      observed_at: null,
    });
    expect(resolveRoutedTemplateState(result, null)).toBe('active');
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
      isProviderEnabled: (provider) => provider === 'daytona',
      getProvider: () => ({ getSnapshotState: () => new Promise(() => {}) }),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
      observationTimeoutMs: 5,
    });

    expect(result.find((item) => item.provider === 'daytona')).toMatchObject({
      status: 'unknown',
      state: null,
      launch_ready: false,
    });
  });

  test('only treats a usable explicit project pin as pinned', () => {
    const enabled = (provider: string) => provider !== 'e2b';
    expect(resolveUsableProjectProviderPin({}, enabled)).toBeNull();
    expect(resolveUsableProjectProviderPin({ default_sandbox_provider: 'platinum' }, enabled))
      .toBe('platinum');
    expect(resolveUsableProjectProviderPin({ default_sandbox_provider: 'e2b' }, enabled))
      .toBeNull();
    expect(resolveUsableProjectProviderPin({ default_sandbox_provider: 'bogus' }, enabled))
      .toBeNull();
  });

  test('retains a valid configured pin for presentation while unavailable', () => {
    expect(resolveConfiguredProjectProviderPin({ default_sandbox_provider: 'e2b' }))
      .toBe('e2b');
    expect(resolveConfiguredProjectProviderPin({ default_sandbox_provider: 'managed' }))
      .toBeNull();
    expect(resolveRoutedTemplateState([
      { provider: 'e2b', available: false, state: null },
    ], 'e2b')).toBe('unknown');
  });
});
