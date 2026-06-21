// Supported locales (must match web)
export const SUPPORTED_LOCALES = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';
