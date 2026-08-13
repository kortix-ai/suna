import { config } from '../config';

/**
 * Can this deployment deliver a network-boundary secret at all?
 *
 * Two independent mechanisms can satisfy it, and a project needs only one:
 *
 *  - **Provider edge (Platinum).** Kortix registers the credential with the
 *    provider and its egress proxy injects on allow-listed hosts. Nothing runs
 *    in the guest.
 *  - **In-guest shim (everything else, notably Daytona).** The shim terminates
 *    the guest's TLS and relays to the broker route, which injects server-side.
 *    The guest still never holds the credential — see
 *    docs/NETWORK_BOUNDARY_ON_DAYTONA.md §7.4.
 *
 * This used to be `config.isPlatinumEnabled()` alone, which is why the feature
 * was unavailable to every production project: production runs on Daytona.
 */
export function networkBoundaryDeliveryAvailable(): boolean {
  return config.isPlatinumEnabled() || networkBoundaryShimAvailable();
}

/**
 * Is the in-guest shim path available?
 *
 * Gated so an operator can withdraw it without a code change, and so a
 * deployment whose sandbox image predates the shim does not advertise a
 * delivery mode its guests cannot perform. `optBoolTrue` disables on the
 * literal string `false` only.
 */
export function networkBoundaryShimAvailable(): boolean {
  return config.EGRESS_SHIM_ENABLED;
}

/**
 * Which mechanism a given provider uses.
 *
 * The provider edge is preferred where it exists: it needs nothing in the guest
 * and injects for any client, whereas the shim only serves requests routed
 * through it.
 */
export function networkBoundaryMode(providerName: string): 'provider-edge' | 'in-guest-shim' | null {
  if (providerName === 'platinum' && config.isPlatinumEnabled()) return 'provider-edge';
  if (networkBoundaryShimAvailable()) return 'in-guest-shim';
  return null;
}
