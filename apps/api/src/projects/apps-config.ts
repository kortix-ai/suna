/**
 * Per-project gate for the experimental `[[apps]]` deployment surface.
 *
 * Apps is one entry in the unified experimental-feature registry
 * ({@link ../experimental/features}). This thin shim keeps the original
 * `resolveAppsEnabled(metadata)` name that the /apps routes + sweep already
 * call, delegating to the registry so there is a single source of truth.
 *
 * DB-only — never in kortix.toml.
 */
import { resolveExperimentalFeature } from '../experimental/features';

/** Effective apps gate for a project. See the registry for resolution rules. */
export function resolveAppsEnabled(metadata: unknown): boolean {
  return resolveExperimentalFeature(metadata, 'apps');
}
