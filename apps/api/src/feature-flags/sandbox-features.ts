import type { FeatureFlagKey } from '@kortix/api-contract';
import { resolveFeatureFlag } from './registry';

/** Flags the in-sandbox CLI needs to know about (it hides commands for a flag that is off). */
const SANDBOX_FEATURE_FLAGS: readonly FeatureFlagKey[] = ['human_messaging'];

/**
 * Value of `KORTIX_FEATURES`: comma list of the enabled flags above, or
 * `none`. Never empty: the CLI reads "variable present" as "inside a sandbox
 * that reports its flags", so an all-off project must still carry a value.
 */
export function sandboxFeaturesValue(metadata: unknown): string {
  const on = SANDBOX_FEATURE_FLAGS.filter((key) => resolveFeatureFlag(metadata, key));
  return on.length ? on.join(',') : 'none';
}
