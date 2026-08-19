/**
 * The availability gate decides whether the API ADVERTISES network-boundary
 * delivery — save-time validation, `delivery_status`, and the web control all
 * read it. Getting it wrong in the permissive direction ships a feature that
 * looks available and silently does nothing, so the default is pinned here.
 *
 * The shim half is a PER-PROJECT experimental flag rather than an operator env
 * var. What it really depends on is a sandbox image new enough to run the shim,
 * which the API cannot introspect — so it is a human decision, and scoping it
 * per project lets one project opt in and be verified before anything else is
 * exposed to it.
 *
 * The mode half is parameterized over config.KNOWN_PROVIDERS rather than
 * written per provider. Only one name is ever compared in the whole delivery
 * chain and it is here, so a provider that reaches this gate without an
 * expectation is a provider whose boundary story nobody decided.
 */
import { describe, expect, test } from 'bun:test';
import { KNOWN_PROVIDERS, config } from '../config';
import {
  networkBoundaryDeliveryAvailable,
  networkBoundaryMode,
  networkBoundaryShimAvailable,
} from './network-boundary-availability';

/** Project metadata with the flag explicitly on/off. The override map lives at
 *  `projects.metadata.experimental` — a stable storage detail. */
const withShim = (on: boolean) => ({ experimental: { network_boundary_shim: on } });
const noOverrides = {};

/**
 * The mechanism each known provider is expected to resolve to once a project
 * has opted in. Declared as a map rather than written out per assertion so the
 * exhaustiveness check below fails when a provider joins config.KNOWN_PROVIDERS
 * without anyone deciding its boundary story.
 *
 * The default for a new entry is 'in-guest-shim'. Only a provider that
 * implements `syncNetworkBoundary` — an egress edge Kortix can register a
 * credential with — belongs on the other side.
 */
const EXPECTED_MODE: Record<string, 'provider-edge' | 'in-guest-shim'> = {
  daytona: 'in-guest-shim',
  platinum: 'provider-edge',
  e2b: 'in-guest-shim',
};

function withPlatinum<T>(enabled: boolean, run: () => T): T {
  const original = config.isPlatinumEnabled;
  try {
    (config as { isPlatinumEnabled: () => boolean }).isPlatinumEnabled = () => enabled;
    return run();
  } finally {
    (config as { isPlatinumEnabled: () => boolean }).isPlatinumEnabled = original;
  }
}

describe('network boundary availability', () => {
  test('a project that has not opted in gets nothing without Platinum', () => {
    // The default has to be off: turning it on for a project whose sandbox
    // image predates the shim means the secret saves and nothing can spend it.
    withPlatinum(false, () => {
      expect(networkBoundaryShimAvailable(noOverrides)).toBe(false);
      expect(networkBoundaryDeliveryAvailable(noOverrides)).toBe(false);
    });
  });

  test('absent metadata is treated as not opted in', () => {
    // Callers that cannot supply the project must not accidentally widen the
    // gate; an unknown project is a closed one.
    withPlatinum(false, () => {
      expect(networkBoundaryShimAvailable(undefined)).toBe(false);
      expect(networkBoundaryDeliveryAvailable(undefined)).toBe(false);
    });
  });

  test('Platinum alone still satisfies availability, as before', () => {
    withPlatinum(true, () => {
      expect(networkBoundaryDeliveryAvailable(noOverrides)).toBe(true);
    });
  });

  test('the flag makes it available on a provider with no credential edge', () => {
    withPlatinum(false, () => {
      expect(networkBoundaryShimAvailable(withShim(true))).toBe(true);
      expect(networkBoundaryDeliveryAvailable(withShim(true))).toBe(true);
    });
  });

  test('an explicit off is respected even where Platinum exists', () => {
    withPlatinum(true, () => {
      expect(networkBoundaryShimAvailable(withShim(false))).toBe(false);
      // Platinum still covers the project — the flag only governs the shim.
      expect(networkBoundaryDeliveryAvailable(withShim(false))).toBe(true);
    });
  });
});

describe('networkBoundaryMode across every known provider', () => {
  test('every provider Kortix can run has a declared boundary mechanism', () => {
    // The gate takes a provider NAME, so nothing stops a new provider from
    // reaching it; without this check it would inherit whichever branch it
    // happens to fall into and nobody would have decided that.
    expect(Object.keys(EXPECTED_MODE).sort()).toEqual([...KNOWN_PROVIDERS].sort());
  });

  test('an opted-in project gets a mechanism on every provider', () => {
    // The edge injects for ANY client; the shim only for requests routed
    // through it. Where both exist the edge is strictly better, so it wins —
    // which is the only reason the two columns differ at all.
    withPlatinum(true, () => {
      for (const name of KNOWN_PROVIDERS) {
        expect(networkBoundaryMode(name, withShim(true)), name).toBe(EXPECTED_MODE[name]);
      }
    });
  });

  test('without the flag, only a provider edge delivers', () => {
    withPlatinum(true, () => {
      for (const name of KNOWN_PROVIDERS) {
        const edge = EXPECTED_MODE[name] === 'provider-edge';
        expect(networkBoundaryMode(name, noOverrides), name).toBe(edge ? 'provider-edge' : null);
      }
    });
  });

  test('with Platinum unconfigured, the shim is the only mechanism anywhere', () => {
    // A deployment with no Platinum credentials has no edge to register with,
    // so even the name 'platinum' falls through to the shim rather than
    // claiming a delivery path that cannot run.
    withPlatinum(false, () => {
      for (const name of KNOWN_PROVIDERS) {
        expect(networkBoundaryMode(name, withShim(true)), name).toBe('in-guest-shim');
        expect(networkBoundaryMode(name, noOverrides), name).toBeNull();
      }
    });
  });
});
