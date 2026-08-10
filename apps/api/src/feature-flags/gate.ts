/**
 * The one server-side gate for flag-gated HTTP surface.
 *
 * Usage, ALWAYS after membership authz (so non-members learn nothing):
 *
 *   const gate = requireFeatureFlag(c, loaded.row.metadata, 'review_center');
 *   if (gate) return gate;
 *
 * Every gated route rejects identically: 403 with the machine-readable
 * `feature_disabled` code and the flag key. Clients (SDK error surface, CLI
 * message, web gate screens) key off `code`, never off prose.
 * Wire shape: @kortix/api-contract FeatureDisabledErrorSchema.
 */
import type { Context } from 'hono';
import type { FeatureFlagKey } from '@kortix/api-contract';
import { featureFlagDef, resolveFeatureFlag } from './registry';

export const FEATURE_DISABLED_CODE = 'feature_disabled' as const;

export function featureDisabledBody(key: FeatureFlagKey): {
  error: string;
  code: typeof FEATURE_DISABLED_CODE;
  feature: FeatureFlagKey;
} {
  const def = featureFlagDef(key);
  return {
    error: `${def?.name ?? key} is not enabled for this project. Enable it in Settings → Feature flags.`,
    code: FEATURE_DISABLED_CODE,
    feature: key,
  };
}

/**
 * Returns the 403 response when the flag is off for this project, else null.
 * Fail-closed: unknown metadata shapes and unavailable flags reject.
 */
export function requireFeatureFlag(
  c: Context,
  metadata: unknown,
  key: FeatureFlagKey,
): Response | null {
  if (resolveFeatureFlag(metadata, key)) return null;
  return c.json(featureDisabledBody(key), 403);
}
