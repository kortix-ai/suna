// Supported locales (must match web)
export const SUPPORTED_LOCALES = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * Whether users can pick a UI language. Off until the core screens (projects,
 * session, composer, drawer) read their strings from `locales/*.json`: today
 * a non-English pick translates settings and billing only.
 *
 * While off, the Language row is hidden and the UI stays in `DEFAULT_LOCALE`
 * whatever the profile says. The profile `user_metadata.locale` is kept
 * untouched, so turning this on restores each user's earlier choice.
 * The i18n setup and every locale file stay in place.
 */
export const LANGUAGE_PICKER_ENABLED = false;
