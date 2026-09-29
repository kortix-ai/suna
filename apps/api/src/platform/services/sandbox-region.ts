import { resolveFeatureFlag } from '../../feature-flags/registry';
import { platinumUsRegion } from '../../shared/platinum-region';

/**
 * The region a session's sandbox is created in, or `undefined` for the
 * provider's home region. Provider-neutral on purpose: it rides in
 * `CreateSandboxOpts.location`, which only the Platinum provider reads.
 *
 * Resolved at every provisioning, so a session that restarts after the
 * project flips `us_region` comes back in the region the flag now names. A
 * running box never moves.
 */
export function resolveSessionSandboxRegion(projectMetadata: unknown): string | undefined {
  if (!resolveFeatureFlag(projectMetadata, 'us_region')) return undefined;
  return platinumUsRegion() ?? undefined;
}
