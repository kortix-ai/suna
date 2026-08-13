/**
 * The availability gate decides whether the API ADVERTISES network-boundary
 * delivery — save-time validation, delivery_status, and the web control all
 * read it. Getting it wrong in the permissive direction ships a feature that
 * looks available and silently does nothing, so the default is pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import {
  networkBoundaryDeliveryAvailable,
  networkBoundaryMode,
  networkBoundaryShimAvailable,
} from './network-boundary-availability';

function withConfig<T>(patch: { platinum?: boolean; shim?: boolean }, run: () => T): T {
  const originalShim = config.EGRESS_SHIM_ENABLED;
  const originalIsPlatinum = config.isPlatinumEnabled;
  try {
    if (patch.shim !== undefined) {
      (config as { EGRESS_SHIM_ENABLED: boolean }).EGRESS_SHIM_ENABLED = patch.shim;
    }
    if (patch.platinum !== undefined) {
      (config as { isPlatinumEnabled: () => boolean }).isPlatinumEnabled = () => patch.platinum!;
    }
    return run();
  } finally {
    (config as { EGRESS_SHIM_ENABLED: boolean }).EGRESS_SHIM_ENABLED = originalShim;
    (config as { isPlatinumEnabled: () => boolean }).isPlatinumEnabled = originalIsPlatinum;
  }
}

describe('network boundary availability', () => {
  test('the shim is OFF unless an operator turns it on', () => {
    // Pins the sequencing decision: the API must not advertise boundary
    // delivery to non-Platinum projects before the guest can perform it.
    expect(config.EGRESS_SHIM_ENABLED).toBe(false);
  });

  test('Platinum alone still satisfies availability, as before', () => {
    withConfig({ platinum: true, shim: false }, () => {
      expect(networkBoundaryDeliveryAvailable()).toBe(true);
      expect(networkBoundaryMode('platinum')).toBe('provider-edge');
    });
  });

  test('with the shim off and no Platinum, the feature stays unavailable', () => {
    withConfig({ platinum: false, shim: false }, () => {
      expect(networkBoundaryDeliveryAvailable()).toBe(false);
      expect(networkBoundaryShimAvailable()).toBe(false);
      expect(networkBoundaryMode('daytona')).toBeNull();
    });
  });

  test('the shim makes it available on a provider with no credential edge', () => {
    withConfig({ platinum: false, shim: true }, () => {
      expect(networkBoundaryDeliveryAvailable()).toBe(true);
      expect(networkBoundaryMode('daytona')).toBe('in-guest-shim');
    });
  });

  test('Platinum keeps the provider edge even when the shim is available', () => {
    // The edge injects for ANY client; the shim only for requests routed
    // through it. Where both exist the edge is strictly better, so it wins.
    withConfig({ platinum: true, shim: true }, () => {
      expect(networkBoundaryMode('platinum')).toBe('provider-edge');
      expect(networkBoundaryMode('daytona')).toBe('in-guest-shim');
    });
  });
});
