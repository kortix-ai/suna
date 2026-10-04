import { resolveFeatureFlag } from '../../feature-flags/registry';
import { platinumUsRegion } from '../../sandboxes/platinum/region';

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
