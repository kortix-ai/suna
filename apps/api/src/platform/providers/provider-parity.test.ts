/**
 * Cross-cutting parity guard: every ProviderName must be wired into every
 * shared subsystem — the runtime registry, its compute rate card, the App
 * runtime contract, the snapshot-build adapter registry, and network-boundary
 * delivery. Written so that adding another provider without wiring it into one
 * of those places fails a test here instead of silently under-covering it in
 * production (the exact gap this suite closes for every provider in the
 * canonical registry).
 *
 * Network boundary is the member that needed pinning most. The whole delivery
 * chain branches on a single question — does this provider expose a credential
 * edge? — and never on a provider's name, but nothing enforced that: dropping
 * `if (providerName === 'e2b') return null;` into networkBoundaryMode used to
 * leave the entire repo suite green while the feature disappeared for E2B.
 */
import { describe, expect, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona,platinum,e2b';
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
const { getProvider, shouldSyncProviderNetworkBoundary } = await import('./index');
const { networkBoundaryMode } = await import('../../secrets/network-boundary-availability');
const { getProviderComputeRateCard } = await import('./compute-rates');
const { effectiveAppMachine } = await import('./index');
const { getSandboxProvider } = await import('../../snapshots/providers');
const { SANDBOX_TEMPLATE_PROVIDERS } = await import('../../snapshots/provider-coverage');

/** Project metadata, as the feature-flag registry reads it: the per-project
 *  override map lives at `projects.metadata.experimental`. */
const shimOptedIn = { experimental: { network_boundary_shim: true } };
const noOverrides = {};

describe('sandbox provider parity across shared subsystems', () => {
  test('config.KNOWN_PROVIDERS is the single canonical provider list every other list must match', () => {
    expect(KNOWN_PROVIDERS).toEqual(['daytona', 'platinum', 'e2b']);
    expect(new Set(SANDBOX_TEMPLATE_PROVIDERS)).toEqual(new Set(KNOWN_PROVIDERS));
  });

  for (const name of ['daytona', 'platinum', 'e2b'] as const) {
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

    test(`${name}: can host an App runtime and declares what of the machine it enforces`, () => {
      const provider = getProvider(name);
      // Every provider must be able to bring the App supervisor back. A no-op
      // here silently disables AppHostingProvider.waitUntilReady's recovery.
      expect(typeof provider.ensureAppRuntimeStarted).toBe('function');

      // Billing meters the EFFECTIVE machine, so a dimension the provider
      // cannot set must resolve to zero rather than to the requested number.
      const requested = { cpuCores: 2, memoryGb: 4, diskGb: 10 };
      const effective = effectiveAppMachine(provider, requested);
      const support = provider.appMachineSupport ?? { cpu: true, memoryGb: true, diskGb: true };
      expect(effective.cpuCores).toBe(support.cpu ? requested.cpuCores : 0);
      expect(effective.memoryGb).toBe(support.memoryGb ? requested.memoryGb : 0);
      expect(effective.diskGb).toBe(support.diskGb ? requested.diskGb : 0);
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

    test(`${name}: can deliver a network-boundary secret by capability, not by name`, () => {
      // A provider-edge verdict needs Platinum credentials to be configured;
      // the env block at the top of this file supplies them, so the mode
      // expectations below can be stated unconditionally.
      expect(config.isPlatinumEnabled()).toBe(true);

      const provider = getProvider(name);
      const hasEdge = typeof provider.syncNetworkBoundary === 'function';
      expect(hasEdge).toBe(name === 'platinum');

      // No edge is not "no boundary": the in-guest shim covers every other
      // provider with the same code, which is why a new runtime gets the
      // feature without a line of its own anywhere on the delivery path.
      expect(networkBoundaryMode(name, shimOptedIn)).toBe(
        hasEdge ? 'provider-edge' : 'in-guest-shim',
      );
      expect(networkBoundaryMode(name, noOverrides)).toBe(hasEdge ? 'provider-edge' : null);

      // The edge is authoritative — it holds the whole credential set, so it is
      // reconciled even with nothing to install (that is how a revoked binding
      // gets removed). A shim provider keeps no server-side state to clear, so
      // it syncs only when there are bindings.
      expect(shouldSyncProviderNetworkBoundary(name, 0)).toBe(hasEdge);
      expect(shouldSyncProviderNetworkBoundary(name, 1)).toBe(true);
    });
  }

  test('providers with no credential edge are treated identically', () => {
    // NETWORK_BOUNDARY_SYNC_MODE is an exhaustive Record<ProviderName, …>, so a
    // new provider cannot compile without an entry there — that one line is the
    // whole cost of joining. What the type cannot catch is an entry that
    // disagrees with another provider running the very same shim path: a silent
    // behaviour split rather than a build error.
    for (const bindingCount of [0, 1]) {
      expect(shouldSyncProviderNetworkBoundary('e2b', bindingCount)).toBe(
        shouldSyncProviderNetworkBoundary('daytona', bindingCount),
      );
    }
    expect(networkBoundaryMode('e2b', shimOptedIn)).toBe(
      networkBoundaryMode('daytona', shimOptedIn),
    );
    expect(networkBoundaryMode('e2b', noOverrides)).toBe(
      networkBoundaryMode('daytona', noOverrides),
    );
  });

  test('E2B cannot size an App disk, so an App on E2B is not billed for one', () => {
    // e2b 2.37.0 Template.build takes cpuCount and memoryMB only — there is no
    // disk parameter — so disk_gb is provider-managed there. Charging the
    // requested disk billed storage Kortix never asked E2B to allocate.
    expect(getProvider('e2b').appMachineSupport).toEqual({ cpu: true, memoryGb: true, diskGb: false });
    expect(effectiveAppMachine(getProvider('e2b'), { cpuCores: 4, memoryGb: 8, diskGb: 50 }))
      .toEqual({ cpuCores: 4, memoryGb: 8, diskGb: 0 });

    // Daytona and Platinum size the whole machine at build time, so they meter
    // exactly what the App asked for.
    for (const name of ['daytona', 'platinum'] as const) {
      expect(effectiveAppMachine(getProvider(name), { cpuCores: 4, memoryGb: 8, diskGb: 50 }))
        .toEqual({ cpuCores: 4, memoryGb: 8, diskGb: 50 });
    }
  });
});
