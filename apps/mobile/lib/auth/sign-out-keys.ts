/**
 * AsyncStorage keys that survive sign-out: device preferences that do not
 * belong to an account. Every other key is cleared, so the next user of the
 * device never sees the previous user's queue, tabs, projects or cached data.
 */
const PRESERVED_KEYS: ReadonlySet<string> = new Set([
  '@theme_preference', // stores/theme-store.ts
  '@kortix_language', // lib/utils/i18n.ts
  '@push_registration', // stores/push-store.ts: device push token, prompt shown
]);

/** Onboarding completion flags are per-device caches of profile state. */
const ONBOARDING_KEY_MARKER = 'onboarding_completed';

export function keysToClear(allKeys: readonly string[]): string[] {
  return allKeys.filter(
    (key) => !PRESERVED_KEYS.has(key) && !key.includes(ONBOARDING_KEY_MARKER)
  );
}
