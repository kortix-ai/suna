/**
 * When may an account-state query run?
 *
 * Account state is cached per accountId, so a surface that learns its account
 * late (the project shell, which reads it off `project-detail`) walks two
 * different cache slots: first the provisional "primary account" slot, then
 * the real one. Each slot starts empty, so every consumer that renders on
 * presence of data — the sidebar's Upgrade Plan button, the balance warning —
 * paints, unpaints, and paints again on a single cold load.
 *
 * The fix is to not ask until we know who we're asking about. An explicitly
 * passed accountId is always answerable; a context-derived one waits for the
 * provider to resolve.
 */
export function shouldQueryAccountState(input: {
  /** The caller's own `enabled` option. */
  enabled: boolean;
  /** True when the call site passed a concrete accountId of its own. */
  hasExplicitAccountId: boolean;
  /** {@link useBillingAccountResolved} — true outside any provider. */
  contextResolved: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.hasExplicitAccountId) return true;
  return input.contextResolved;
}
