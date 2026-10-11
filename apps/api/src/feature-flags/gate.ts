/**
 * The one server-side gate for flag-gated HTTP surface.
 *
 * Usage, ALWAYS after membership authz (so non-members learn nothing):
 *
 *   const gate = requireFeatureFlag(c, loaded.row.metadata, 'apps');
 *   if (gate) return gate;
 *
 * Every gated route rejects identically: 403 with the machine-readable
 * `feature_disabled` code and the flag key. Clients (SDK error surface, CLI
 * message, web gate screens) key off `code`, never off prose.
 * Wire shape: @kortix/api-contract FeatureDisabledErrorSchema.
 */
import type { FeatureFlagKey } from '@kortix/api-contract';
import { featureFlagDef } from './registry';

// `requireFeatureFlag` answers with a Hono response, so it lives in
// `http-gate.ts`. Re-exported here so every importer and mock keeps working.
export { requireFeatureFlag } from './http-gate';

export const FEATURE_DISABLED_CODE = 'feature_disabled' as const;

/** 403 code: only a platform operator may write this flag (`catalogHidden`). */
export const FEATURE_OPERATOR_ONLY_CODE = 'feature_operator_only' as const;

export function featureDisabledBody(key: FeatureFlagKey): {
  error: string;
  code: typeof FEATURE_DISABLED_CODE;
  feature: FeatureFlagKey;
} {
  const def = featureFlagDef(key);
  return {
    error: def?.derivedFrom
      ? `${def.name} is not enabled for this organization.`
      : def?.catalogHidden
      ? `${def.name} is not enabled for this project. Contact Kortix to enable it.`
      : `${def?.name ?? key} is not enabled for this project. Enable it in Settings → Feature flags.`,
    code: FEATURE_DISABLED_CODE,
    feature: key,
  };
}
