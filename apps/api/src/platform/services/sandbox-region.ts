import { resolveFeatureFlag } from '../../feature-flags/registry';
import { platinumUsRegion } from '../../shared/platinum-region';
import { apiRegion, databaseRegion } from '../../lib/deployment-region';

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
  const region = platinumUsRegion();
  if (!region) return undefined;

  // Never place a US sandbox beside a different API, database, or archive bucket.
  // An unknown region is not proof of co-location; keep the existing placement.
  const awsRegion = region === 'us-east' ? 'us-east-1' : null;
  if (!awsRegion || apiRegion() !== awsRegion || databaseRegion(process.env.DATABASE_URL ?? '') !== awsRegion ||
      process.env.KORTIX_PROJECT_SNAPSHOT_S3_REGION !== awsRegion ||
      process.env.KORTIX_CONFIG_ARCHIVE_S3_REGION !== awsRegion) return undefined;
  return region;
}
