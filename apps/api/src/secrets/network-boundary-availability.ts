import { config } from '../config';
import { resolveFeatureFlag } from '../feature-flags/registry';

/**
 * Can a given project deliver a network-boundary secret?
 *
 * Two independent mechanisms satisfy it, and a project needs only one:
 *
 *  - **Provider edge (Platinum).** Kortix registers the credential with the
 *    provider and its egress proxy injects on allow-listed hosts. Nothing runs
 *    in the guest, and it applies to every client in the sandbox.
 *  - **In-guest shim (any other provider, notably Daytona).** The shim
 *    terminates the guest's TLS and relays to the broker route, which injects
 *    server-side. The guest still never holds the credential — see
 *    docs/NETWORK_BOUNDARY_WITHOUT_PLATINUM.md §7.4.
 *
 * This used to be `config.isPlatinumEnabled()` alone, which is why the feature
 * was unavailable to every production project: production runs on Daytona.
 *
 * The shim half is a **per-project experimental flag**, not an operator env
 * var. Deliberate: the thing it actually depends on is a sandbox image new
 * enough to run the shim, which the API cannot introspect, so it has to be a
 * human decision — and a per-project one lets a single project opt in and be
 * verified before anything else is exposed to it.
 */
export function networkBoundaryDeliveryAvailable(projectMetadata: unknown): boolean {
  return config.isPlatinumEnabled() || networkBoundaryShimAvailable(projectMetadata);
}

/**
 * Has this project opted into the in-guest shim path?
 *
 * The parameter is REQUIRED on all three functions here. It was optional, which
 * made `networkBoundaryDeliveryAvailable()` — no argument — compile and quietly
 * return the pre-flag Platinum-only verdict. `buildSecretView` was hardened
 * against exactly that and this gate was not, so the compile-time guarantee
 * stopped one call short of the thing it guards. A caller with no project must
 * now write `undefined` and mean it.
 */
export function networkBoundaryShimAvailable(projectMetadata: unknown): boolean {
  if (projectMetadata === undefined) return false;
  return resolveFeatureFlag(projectMetadata, 'network_boundary_shim');
}

/**
 * Which mechanism a project uses, or null when it has none.
 *
 * The provider edge wins where it exists: it needs nothing in the guest and
 * injects for any client, whereas the shim only serves requests routed through
 * it.
 */
export function networkBoundaryMode(
  providerName: string,
  projectMetadata: unknown,
): 'provider-edge' | 'in-guest-shim' | null {
  if (providerName === 'platinum' && config.isPlatinumEnabled()) return 'provider-edge';
  if (networkBoundaryShimAvailable(projectMetadata)) return 'in-guest-shim';
  return null;
}
