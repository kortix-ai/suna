import { resolveFeatureFlag } from '../../feature-flags/registry';
import { platinumUsRegion } from '../../shared/platinum-region';

/**
 * The region a session's sandbox is created in, or `undefined` for the
 * provider's home region. Provider-neutral on purpose: it rides in
 * `CreateSandboxOpts.location`, which only the Platinum provider reads.
 *
 * Resolved at every provisioning. The flag chooses compute placement, not
 * API, database, or archive residency. An existing box keeps its region;
 * only a newly provisioned box uses the current preference.
 */
export function resolveSessionSandboxRegion(projectMetadata: unknown): string | undefined {
  if (!resolveFeatureFlag(projectMetadata, 'us_region')) return undefined;
  return platinumUsRegion() ?? undefined;
}

/**
 * The placement a warm session is created for, stamped on its row
 * (`warmSandboxLocation`) so an in-flight warm create is reused only for the
 * same placement: the region, or `home`, plus `+residential-proxy` while the
 * project's `residential_proxy` flag is on. A row from before the proxy flag
 * holds the bare region, which is still the proxy-off value.
 */
export function warmSandboxIntent(projectMetadata: unknown): string {
  const region = resolveSessionSandboxRegion(projectMetadata) ?? 'home';
  return resolveFeatureFlag(projectMetadata, 'residential_proxy') ? `${region}+residential-proxy` : region;
}
