import type { Context } from 'hono';
import type { FeatureFlagKey } from '@kortix/api-contract';
import { featureDisabledBody } from '../../services/feature-flags/gate';
import { resolveFeatureFlag } from '../../services/feature-flags/registry';

/**
 * Returns the 403 response when the flag is off for this project, else null.
 * Fail-closed: unknown metadata shapes and unavailable flags reject.
 */
export function requireFeatureFlag(
  c: Context,
  metadata: unknown,
  key: FeatureFlagKey,
) {
  if (resolveFeatureFlag(metadata, key)) return null;
  return c.json(featureDisabledBody(key), 403);
}
