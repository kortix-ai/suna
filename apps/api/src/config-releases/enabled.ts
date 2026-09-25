/**
 * The one read of the `config_releases` feature flag
 * (docs/specs/config-releases.md, "Feature flag").
 *
 * The whole feature is behind this flag: the descriptor and archive routes,
 * the release builder, the store, the quarantine ledger, every convergence
 * trigger, and the `release` block of `GET /config`. Off ⇒ none of it runs and
 * OpenCode reads the session's workspace config dir, as it did before config
 * releases existed.
 *
 * Two gates, both from the shared registry:
 *   • operator — `config.CONFIG_RELEASES_ENABLED` (the registry's `available`).
 *     False ⇒ the flag is off for every project, whatever a project chose, and
 *     the Settings row disappears.
 *   • project  — `projects.metadata.experimental.config_releases`, defaulting
 *     to OFF (`registry.ts`, `platformDefault: () => false`) until the rollout
 *     is done. A project opts in, or out again, without a code change.
 *
 * Never inline `resolveFeatureFlag(metadata, 'config_releases')` elsewhere:
 * the chokepoints named in the spec call one of these two functions, so the
 * flag has one meaning and one grep.
 */
import type { FeatureFlagKey } from '@kortix/api-contract';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { resolveFeatureFlag } from '../feature-flags/registry';

export const CONFIG_RELEASES_FLAG: FeatureFlagKey = 'config_releases';

/** Effective state for a project whose row (and metadata) is already loaded. */
export function configReleasesEnabled(projectMetadata: unknown): boolean {
  return resolveFeatureFlag(projectMetadata, CONFIG_RELEASES_FLAG);
}

/**
 * Effective state when only the project id is at hand. Costs one query, so
 * prefer {@link configReleasesEnabled} wherever the row is already loaded.
 * An unknown project resolves to `false` (fail closed).
 */
export function projectConfigReleasesEnabled(projectId: string): Promise<boolean> {
  return projectFeatureFlagEnabled(projectId, CONFIG_RELEASES_FLAG);
}
