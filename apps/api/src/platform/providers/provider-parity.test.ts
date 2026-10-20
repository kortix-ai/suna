/**
 * Cross-cutting parity guard: every ProviderName must be wired into every
 * shared subsystem — the runtime registry, its compute rate card, the App
 * runtime contract, the snapshot-build adapter registry, and network-boundary
 * delivery. Written so that adding another provider without wiring it into one
 * of those places fails a test here instead of silently under-covering it in
 * production (the exact gap this suite closes for every provider in the
 * canonical registry).
 *
 * Network boundary is the member that needed pinning most. It used to branch on
 * whether a provider exposed a credential edge, and nothing enforced that the
 * branch stayed capability-based: a provider-name early return in the mode
 * resolver left the entire repo suite green while the feature disappeared for
 * that provider. There is no branch left to corrupt — one
 * mechanism serves every provider — so what is pinned now is the
 * absence: no provider may grow a credential edge of its own again.
 */
import { describe, expect, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'platinum,daytona';
process.env.DAYTONA_API_KEY = 'daytona_test_key';
process.env.DAYTONA_SERVER_URL = 'https://app.daytona.io/api';
process.env.DAYTONA_TARGET = 'us';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.PLATINUM_API_URL = 'https://api.platinum.test';
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
    expect(KNOWN_PROVIDERS).toEqual(['platinum', 'daytona']);
    expect(new Set(SANDBOX_TEMPLATE_PROVIDERS)).toEqual(new Set(KNOWN_PROVIDERS));
  });

  for (const name of ['platinum', 'daytona'] as const) {
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
    });

    test(`${name}: can host an App runtime`, () => {
      const provider = getProvider(name);
      // Every provider must be able to bring the App supervisor back. A no-op
      // here silently disables AppHostingProvider.waitUntilReady's recovery.
      expect(typeof provider.ensureAppRuntimeStarted).toBe('function');
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

    test(`${name}: delivers an egress-enforced secret through the one shared mechanism`, () => {
      // Platinum credentials are configured by the env block at the top of this
      // file, so a lingering Platinum-only branch would still be reachable here
      // — which is what makes the absence assertion below meaningful.
      expect(config.isPlatinumEnabled()).toBe(true);

      const provider = getProvider(name);
      // No provider registers credentials anywhere. The value is substituted by
      // the broker route per request and never leaves the API, on platinum
      // and daytona alike. A provider that grows a `syncNetworkBoundary` again
      // reintroduces the split this test exists to prevent.
      expect('syncNetworkBoundary' in provider).toBe(false);
    });
  }

  test('no provider is special-cased on the egress-enforced path', () => {
    // The guard the whole file exists for: the runtime objects must be
    // indistinguishable to the secrets path, so a new runtime gets the feature
    // without a line of its own anywhere on it.
    // Walks the prototype chain: these are classes, so the methods live on the
    // prototype and `Object.keys` on the instance would report [] for anything
    // and prove nothing.
    const surface = (name: 'platinum' | 'daytona', needle: string) => {
      const keys = new Set<string>();
      for (
        let o: object | null = getProvider(name) as unknown as object;
        o && o !== Object.prototype;
        o = Object.getPrototypeOf(o) as object | null
      ) {
        for (const key of Object.getOwnPropertyNames(o)) keys.add(key);
      }
      return [...keys].filter((key) => key.toLowerCase().includes(needle)).sort();
    };

    // Positive control: the walk really does see prototype methods.
    for (const name of ['platinum', 'daytona'] as const) {
      expect(surface(name, 'resolveingress')).toEqual(['resolveIngress']);
      expect(surface(name, 'networkboundary')).toEqual([]);
    }
  });
});
