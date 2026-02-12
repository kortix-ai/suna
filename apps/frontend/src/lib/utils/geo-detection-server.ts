/**
 * Server-side geo-detection utilities for language detection based on headers
 * Used in middleware and server components
 */

import { locales, defaultLocale, type Locale } from '@/i18n/config';

/**
 * Detects locale from Accept-Language header
 * This is the primary method for server-side geo-detection
 */
export function detectLocaleFromHeaders(acceptLanguage: string | null): Locale | null {
  if (!acceptLanguage) {
    return null;
  }

  try {
    // Parse Accept-Language header (e.g., "en-US,en;q=0.9,de;q=0.8")
    const languages = acceptLanguage
      .split(',')
      .map(lang => {
        const [locale, q] = lang.trim().split(';');
        const quality = q ? parseFloat(q.replace('q=', '')) : 1.0;
        return { locale: locale.toLowerCase().split('-')[0], quality };
      })
      .sort((a, b) => b.quality - a.quality); // Sort by quality

    // Find first supported locale
    for (const { locale } of languages) {
      if (locales.includes(locale as Locale)) {
        return locale as Locale;
      }
    }

    // Try full language code match (e.g., "de-DE", "it-IT")
    for (const lang of acceptLanguage.split(',')) {
      const locale = lang.trim().split(';')[0].toLowerCase();
      for (const supportedLocale of locales) {
        if (locale.startsWith(supportedLocale)) {
          return supportedLocale;
        }
      }
    }

    return null;
  } catch (error) {
    console.warn('Failed to detect locale from headers:', error);
    return null;
  }
}

/**
 * Gets the best locale match based on Accept-Language header
 * Falls back to default locale if no match found
 */
export function detectBestLocaleFromHeaders(acceptLanguage: string | null): Locale {
  const detected = detectLocaleFromHeaders(acceptLanguage);
  return detected || defaultLocale;
}

