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
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import {
  networkBoundaryDeliveryAvailable,
  networkBoundaryMode,
  networkBoundaryShimAvailable,
} from './network-boundary-availability';

/** Project metadata with the flag explicitly on/off. The override map lives at
 *  `projects.metadata.experimental` — a stable storage detail. */
const withShim = (on: boolean) => ({ experimental: { network_boundary_shim: on } });
const noOverrides = {};

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
      expect(networkBoundaryMode('daytona', noOverrides)).toBeNull();
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
      expect(networkBoundaryMode('platinum', noOverrides)).toBe('provider-edge');
    });
  });

  test('the flag makes it available on a provider with no credential edge', () => {
    withPlatinum(false, () => {
      expect(networkBoundaryShimAvailable(withShim(true))).toBe(true);
      expect(networkBoundaryDeliveryAvailable(withShim(true))).toBe(true);
      expect(networkBoundaryMode('daytona', withShim(true))).toBe('in-guest-shim');
    });
  });

  test('an explicit off is respected even where Platinum exists', () => {
    withPlatinum(true, () => {
      expect(networkBoundaryShimAvailable(withShim(false))).toBe(false);
      // Platinum still covers the project — the flag only governs the shim.
      expect(networkBoundaryDeliveryAvailable(withShim(false))).toBe(true);
    });
  });

  test('Platinum keeps the provider edge even when the project has the flag', () => {
    // The edge injects for ANY client; the shim only for requests routed
    // through it. Where both exist the edge is strictly better, so it wins.
    withPlatinum(true, () => {
      expect(networkBoundaryMode('platinum', withShim(true))).toBe('provider-edge');
      expect(networkBoundaryMode('daytona', withShim(true))).toBe('in-guest-shim');
    });
  });
});
