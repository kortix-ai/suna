/**
 * Geo-detection utilities for language detection based on location
 * Uses timezone as a proxy for geographic location (no API calls needed)
 */

import { locales, defaultLocale, type Locale } from '@/i18n/config';

/**
 * Maps timezone regions to likely languages
 * This is a heuristic - users can always override manually
 */
const TIMEZONE_TO_LOCALE_MAP: Record<string, Locale> = {
  // Europe
  'Europe/Berlin': 'de',
  'Europe/Vienna': 'de',
  'Europe/Zurich': 'de',
  'Europe/Rome': 'it',
  'Europe/Madrid': 'en', // Spanish not supported, default to EN
  'Europe/Paris': 'en', // French not supported, default to EN
  'Europe/London': 'en',
  'Europe/Dublin': 'en',
  'Europe/Amsterdam': 'en', // Dutch not supported, default to EN
  'Europe/Brussels': 'en',
  'Europe/Stockholm': 'en',
  'Europe/Oslo': 'en',
  'Europe/Copenhagen': 'en',
  'Europe/Helsinki': 'en',
  'Europe/Warsaw': 'en',
  'Europe/Prague': 'en',
  'Europe/Budapest': 'en',
  'Europe/Bucharest': 'en',
  'Europe/Athens': 'en',
  'Europe/Lisbon': 'en',
  
  // Americas (mostly English, but some regions)
  'America/New_York': 'en',
  'America/Chicago': 'en',
  'America/Denver': 'en',
  'America/Los_Angeles': 'en',
  'America/Toronto': 'en',
  'America/Vancouver': 'en',
  'America/Mexico_City': 'en', // Spanish not supported
  'America/Sao_Paulo': 'en', // Portuguese not supported
  'America/Buenos_Aires': 'en', // Spanish not supported
  
  // Asia Pacific
  'Asia/Tokyo': 'en', // Japanese not supported
  'Asia/Shanghai': 'en', // Chinese not supported
  'Asia/Hong_Kong': 'en',
  'Asia/Singapore': 'en',
  'Asia/Seoul': 'en', // Korean not supported
  'Asia/Dubai': 'en',
  'Asia/Mumbai': 'en',
  'Asia/Jakarta': 'en',
  'Asia/Bangkok': 'en',
  'Asia/Manila': 'en',
  'Asia/Riyadh': 'en',
  'Asia/Tel_Aviv': 'en',
  'Australia/Sydney': 'en',
  'Australia/Melbourne': 'en',
  'Pacific/Auckland': 'en',
  
  // Africa & Middle East
  'Africa/Cairo': 'en',
  'Africa/Johannesburg': 'en',
  'Africa/Lagos': 'en',
};

/**
 * Detects locale based on browser timezone
 * Returns null if no match found
 */
export function detectLocaleFromTimezone(): Locale | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    // Direct timezone match
    if (TIMEZONE_TO_LOCALE_MAP[timezone]) {
      return TIMEZONE_TO_LOCALE_MAP[timezone];
    }
    
    // Try to match by timezone region (e.g., "Europe/Berlin" -> "Europe" -> check German-speaking countries)
    const region = timezone.split('/')[0];
    
    // German-speaking countries in Europe
    if (timezone.startsWith('Europe/')) {
      const germanTimezones = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich'];
      if (germanTimezones.some(tz => timezone.includes(tz.split('/')[1]))) {
        return 'de';
      }
      
      // Italian timezone
      if (timezone.includes('Rome') || timezone.includes('Milan')) {
        return 'it';
      }
    }
    
    return null;
  } catch (error) {
    console.warn('Failed to detect locale from timezone:', error);
    return null;
  }
}

/**
 * Detects locale from browser language (Accept-Language header)
 */
export function detectLocaleFromBrowser(): Locale | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const browserLang = navigator.language.split('-')[0].toLowerCase();
    if (locales.includes(browserLang as Locale)) {
      return browserLang as Locale;
    }
    
    // Try full language code (e.g., "de-DE", "it-IT")
    const fullLang = navigator.language.toLowerCase();
    for (const locale of locales) {
      if (fullLang.startsWith(locale)) {
        return locale;
      }
    }
    
    return null;
  } catch (error) {
    console.warn('Failed to detect locale from browser:', error);
    return null;
  }
}

/**
 * Gets the best locale match based on multiple detection methods
 * Priority: timezone > browser language > default
 */
export function detectBestLocale(): Locale {
  // Try timezone first (more accurate for geo-detection)
  const timezoneLocale = detectLocaleFromTimezone();
  if (timezoneLocale) {
    return timezoneLocale;
  }
  
  // Fallback to browser language
  const browserLocale = detectLocaleFromBrowser();
  if (browserLocale) {
    return browserLocale;
  }
  
  // Default fallback
  return defaultLocale;
}

