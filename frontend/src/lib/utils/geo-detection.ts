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
  'Europe/Madrid': 'es',
  'Europe/Paris': 'fr',
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
  'America/Mexico_City': 'es',
  'America/Sao_Paulo': 'pt',
  'America/Buenos_Aires': 'es',
  'America/Lima': 'es',
  'America/Santiago': 'es',
  'America/Bogota': 'es',
  'America/Caracas': 'es',
  'America/Montevideo': 'es',
  'America/La_Paz': 'es',
  'America/Asuncion': 'es',
  'America/Guayaquil': 'es',
  'America/Panama': 'es',
  'America/Costa_Rica': 'es',
  'America/Guatemala': 'es',
  'America/Havana': 'es',
  'America/Santo_Domingo': 'es',
  'America/San_Juan': 'es',
  'America/Managua': 'es',
  'America/Tegucigalpa': 'es',
  'America/El_Salvador': 'es',
  'America/Rio_Branco': 'pt',
  'America/Manaus': 'pt',
  'America/Cuiaba': 'pt',
  'America/Campo_Grande': 'pt',
  'America/Recife': 'pt',
  'America/Fortaleza': 'pt',
  'America/Belem': 'pt',
  'America/Araguaina': 'pt',
  'America/Maceio': 'pt',
  'America/Salvador': 'pt',
  'America/Bahia': 'pt',
  'America/Noronha': 'pt',
  
  // Asia Pacific
  'Asia/Tokyo': 'ja',
  'Asia/Shanghai': 'zh',
  'Asia/Beijing': 'zh',
  'Asia/Chongqing': 'zh',
  'Asia/Urumqi': 'zh',
  'Asia/Hong_Kong': 'zh',
  'Asia/Macau': 'zh',
  'Asia/Taipei': 'zh',
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
      
      // Spanish timezones
      if (timezone.includes('Madrid') || timezone.includes('Barcelona')) {
        return 'es';
      }
      
      // French timezones
      if (timezone.includes('Paris')) {
        return 'fr';
      }
    }
    
    // Portuguese-speaking regions
    if (timezone.startsWith('America/')) {
      if (timezone.includes('Sao_Paulo') || timezone.includes('Rio') || timezone.includes('Brasilia') || timezone.includes('Recife') || timezone.includes('Fortaleza') || timezone.includes('Manaus') || timezone.includes('Belem') || timezone.includes('Salvador') || timezone.includes('Campo_Grande') || timezone.includes('Cuiaba') || timezone.includes('Araguaina') || timezone.includes('Maceio') || timezone.includes('Bahia') || timezone.includes('Noronha') || timezone.includes('Rio_Branco')) {
        return 'pt';
      }
      
      // Spanish-speaking regions in Americas
      if (timezone.includes('Mexico') || timezone.includes('Buenos_Aires') || timezone.includes('Lima') || timezone.includes('Santiago') || timezone.includes('Bogota') || timezone.includes('Caracas') || timezone.includes('Montevideo') || timezone.includes('La_Paz') || timezone.includes('Asuncion') || timezone.includes('Guayaquil') || timezone.includes('Panama') || timezone.includes('Costa_Rica') || timezone.includes('Guatemala') || timezone.includes('Havana') || timezone.includes('Santo_Domingo') || timezone.includes('San_Juan') || timezone.includes('Managua') || timezone.includes('Tegucigalpa') || timezone.includes('El_Salvador')) {
        return 'es';
      }
    }
    
    // Chinese-speaking regions
    if (timezone.startsWith('Asia/')) {
      if (timezone.includes('Shanghai') || timezone.includes('Beijing') || timezone.includes('Chongqing') || timezone.includes('Urumqi') || timezone.includes('Hong_Kong') || timezone.includes('Macau') || timezone.includes('Taipei')) {
        return 'zh';
      }
      
      // Japanese timezone
      if (timezone.includes('Tokyo')) {
        return 'ja';
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
    // Log browser language info for debugging
    console.log('🌍 Browser navigator.language:', navigator.language);
    console.log('🌍 Browser navigator.languages:', navigator.languages);
    
    const browserLang = navigator.language.split('-')[0].toLowerCase();
    if (locales.includes(browserLang as Locale)) {
      console.log('🌍 Matched browser language:', browserLang);
      return browserLang as Locale;
    }
    
    // Try full language code (e.g., "de-DE", "it-IT")
    const fullLang = navigator.language.toLowerCase();
    for (const locale of locales) {
      if (fullLang.startsWith(locale)) {
        console.log('🌍 Matched browser language (full code):', locale);
        return locale;
      }
    }
    
    console.log('🌍 No match found for browser language');
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

