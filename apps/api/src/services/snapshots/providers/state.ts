import type { ProviderState } from './index';

/**
 * Normalize the state of a provider object that is known to exist. Daytona,
 * Platinum, and E2B use different words for the same lifecycle. The rest of
 * Kortix consumes only this canonical contract, and only `active` is
 * launchable. Unknown/non-terminal values fail safe as `building` instead of
 * being treated as ready or missing and triggering a duplicate build.
 */
export function normalizeExistingProviderState(state: unknown): Exclude<ProviderState, 'missing'> {
  const value = String(state ?? '').trim().toLowerCase();
  if (value === 'active' || value === 'ready') return 'active';
  if (
    value === 'error' || value === 'failed' || value === 'build_failed' ||
    value === 'cancelled' || value === 'canceled'
  ) return 'build_failed';
  if (value === 'removing' || value === 'deleting') return 'removing';
  return 'building';
}
