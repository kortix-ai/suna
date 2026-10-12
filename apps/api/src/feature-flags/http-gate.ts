// The flag gate as route handlers call it. The 403 body is `featureDisabledBody`
// in `gate.ts`.
import type { Context } from 'hono';
import type { FeatureFlagKey } from '@kortix/api-contract';
import { featureDisabledBody } from './gate';
import { resolveFeatureFlag } from './registry';

/**
 * Returns the 403 response when the flag is off for this project, else null.
 * Fail-closed: unknown metadata shapes and unavailable flags reject.
 */
export function requireFeatureFlag(
  c: Context,
  metadata: unknown,
  key: FeatureFlagKey,
  /** The project's organization; flags derived from Volumes need it. */
  accountId?: string | null,
) {
  if (resolveFeatureFlag(metadata, key, accountId)) return null;
  return c.json(featureDisabledBody(key), 403);
}
