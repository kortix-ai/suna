import { resolveFeatureFlag } from '../feature-flags/registry';

/**
 * The `kortix_version` Kortix writes when it creates a manifest for a project:
 * 3 while the project flag `manifest_v3` is on, else 2. A project that is being
 * created has no metadata yet, so the platform default
 * (`MANIFEST_V3_DEFAULT_ENABLED`) decides. A project that already has a
 * manifest keeps its version: no writer changes it.
 */
export function newManifestVersion(projectMetadata: unknown = {}): 2 | 3 {
  return resolveFeatureFlag(projectMetadata, 'manifest_v3') ? 3 : 2;
}
