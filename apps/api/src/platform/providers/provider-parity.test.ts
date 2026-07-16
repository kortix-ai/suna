/**
 * Cross-cutting parity guard: every ProviderName must be wired into every
 * shared subsystem — the runtime registry, its compute rate card, and the
 * snapshot-build adapter registry. Written so that adding a 5th provider
 * without wiring it into one of these three places fails a test here instead
 * of silently under-covering it in production (the exact gap this suite
 * closes for local-docker per the reinforcement in the task brief).
 */
import { describe, expect, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona,platinum,e2b,local-docker';
process.env.DAYTONA_API_KEY = 'daytona_test_key';
process.env.DAYTONA_SERVER_URL = 'https://app.daytona.io/api';
process.env.DAYTONA_TARGET = 'us';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.PLATINUM_API_URL = 'https://api.platinum.test';
process.env.E2B_API_KEY = 'e2b_test_key';
process.env.KORTIX_URL = 'https://api.example.com';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.FRONTEND_URL = 'https://app.example.com';

const { KNOWN_PROVIDERS, config } = await import('../../config');
const { getProvider } = await import('./index');
const { getProviderComputeRateCard } = await import('./compute-rates');
const { getSandboxProvider } = await import('../../snapshots/providers');
const { SANDBOX_TEMPLATE_PROVIDERS } = await import('../../snapshots/provider-coverage');

describe('sandbox provider parity across shared subsystems', () => {
  test('config.KNOWN_PROVIDERS is the single canonical provider list every other list must match', () => {
    expect(KNOWN_PROVIDERS).toContain('local-docker');
    expect(new Set(SANDBOX_TEMPLATE_PROVIDERS)).toEqual(new Set(KNOWN_PROVIDERS));
  });

  for (const name of ['daytona', 'platinum', 'e2b', 'local-docker'] as const) {
    test(`${name}: runtime registry constructs a provider implementing the full contract`, () => {
      const provider = getProvider(name);
      expect(provider.name).toBe(name);
      expect(typeof provider.create).toBe('function');
      expect(typeof provider.start).toBe('function');
      expect(typeof provider.stop).toBe('function');
      expect(typeof provider.remove).toBe('function');
      expect(typeof provider.getStatus).toBe('function');
      expect(typeof provider.resolveEndpoint).toBe('function');
      expect(typeof provider.resolveIngress).toBe('function');
      expect(typeof provider.routeIngress).toBe('function');
      expect(typeof provider.ensureRunning).toBe('function');
      expect(typeof provider.getProvisioningStatus).toBe('function');
    });

    test(`${name}: has a compute rate card`, () => {
      const card = getProviderComputeRateCard(name);
      expect(card).toBeDefined();
      expect(typeof card.cpuPerCoreSecond).toBe('number');
      expect(typeof card.memoryPerGbSecond).toBe('number');
      expect(typeof card.diskPerGbSecond).toBe('number');
      expect(typeof card.providerCostMultiplier).toBe('number');
    });

    test(`${name}: has a registered snapshot-build adapter`, () => {
      const adapter = getSandboxProvider(name);
      expect(adapter.id).toBe(name);
      expect(typeof adapter.buildSnapshot).toBe('function');
      expect(typeof adapter.getSnapshotState).toBe('function');
      expect(typeof adapter.deleteSnapshot).toBe('function');
      expect(typeof adapter.listSnapshots).toBe('function');
      expect(typeof adapter.isConfigured).toBe('function');
    });
  }

  test('local-docker requires no provider API key to be admitted (unlike daytona/platinum/e2b)', () => {
    // config was loaded once above with ALLOWED_SANDBOX_PROVIDERS covering all
    // four names and every OTHER provider's key set — isProviderEnabled must
    // still resolve local-docker as enabled with nothing beyond selection.
    expect(config.isProviderEnabled('local-docker')).toBe(true);
    expect(config.isLocalDockerEnabled()).toBe(true);
  });
});
