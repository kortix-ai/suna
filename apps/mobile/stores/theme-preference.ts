/**
 * Theme preference parsing — the single source of the default theme.
 *
 * Pure (no React Native imports) so it runs under `bun test`. Every reader of
 * the persisted `@theme_preference` key goes through `parseThemePreference`,
 * so a fresh install and a corrupt value both land on the same default.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

/** A device with no saved choice starts in light mode. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light';

export function parseThemePreference(saved: string | null | undefined): ThemePreference {
  return saved === 'light' || saved === 'dark' || saved === 'system'
    ? saved
    : DEFAULT_THEME_PREFERENCE;
}
