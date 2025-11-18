/**
 * Geo-detection utilities for language detection based on device settings
 * Uses device locale and timezone to detect user's preferred language
 */

import { Platform } from 'react-native';

// Supported locales (must match frontend and backend)
export const SUPPORTED_LOCALES = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * Maps timezone regions to likely languages
 * This is a heuristic - users can always override manually
 */
const TIMEZONE_TO_LOCALE_MAP: Record<string, SupportedLocale> = {
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
  
  // Americas
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
 * Detects locale based on device timezone
 * Returns null if no match found
 */
export function detectLocaleFromTimezone(): SupportedLocale | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log('🌍 Device timezone:', timezone);
    
    // Direct timezone match
    if (TIMEZONE_TO_LOCALE_MAP[timezone]) {
      console.log('🌍 Matched timezone to locale:', TIMEZONE_TO_LOCALE_MAP[timezone]);
      return TIMEZONE_TO_LOCALE_MAP[timezone];
    }
    
    // Try to match by timezone region
    if (timezone.startsWith('Europe/')) {
      // German-speaking countries
      if (timezone.includes('Berlin') || timezone.includes('Vienna') || timezone.includes('Zurich')) {
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
      if (timezone.includes('Sao_Paulo') || timezone.includes('Rio') || timezone.includes('Brasilia') || 
          timezone.includes('Recife') || timezone.includes('Fortaleza') || timezone.includes('Manaus') || 
          timezone.includes('Belem') || timezone.includes('Salvador') || timezone.includes('Campo_Grande') || 
          timezone.includes('Cuiaba') || timezone.includes('Araguaina') || timezone.includes('Maceio') || 
          timezone.includes('Bahia') || timezone.includes('Noronha') || timezone.includes('Rio_Branco')) {
        return 'pt';
      }
      
      // Spanish-speaking regions in Americas
      if (timezone.includes('Mexico') || timezone.includes('Buenos_Aires') || timezone.includes('Lima') || 
          timezone.includes('Santiago') || timezone.includes('Bogota') || timezone.includes('Caracas') || 
          timezone.includes('Montevideo') || timezone.includes('La_Paz') || timezone.includes('Asuncion') || 
          timezone.includes('Guayaquil') || timezone.includes('Panama') || timezone.includes('Costa_Rica') || 
          timezone.includes('Guatemala') || timezone.includes('Havana') || timezone.includes('Santo_Domingo') || 
          timezone.includes('San_Juan') || timezone.includes('Managua') || timezone.includes('Tegucigalpa') || 
          timezone.includes('El_Salvador')) {
        return 'es';
      }
    }
    
    // Chinese-speaking regions
    if (timezone.startsWith('Asia/')) {
      if (timezone.includes('Shanghai') || timezone.includes('Beijing') || timezone.includes('Chongqing') || 
          timezone.includes('Urumqi') || timezone.includes('Hong_Kong') || timezone.includes('Macau') || 
          timezone.includes('Taipei')) {
        return 'zh';
      }
      
      // Japanese timezone
      if (timezone.includes('Tokyo')) {
        return 'ja';
      }
    }
    
    return null;
  } catch (error) {
    console.warn('⚠️ Failed to detect locale from timezone:', error);
    return null;
  }
}

/**
 * Detects locale from device language settings
 * Uses React Native's locale detection and Intl API
 */
export function detectLocaleFromDevice(): SupportedLocale | null {
  try {
    // Get device locale - try multiple methods for reliability
    let deviceLocale: string | null = null;
    
    // Method 1: Try Intl API (most reliable, works on both iOS and Android)
    try {
      deviceLocale = Intl.DateTimeFormat().resolvedOptions().locale;
      console.log('🌍 Got locale from Intl API:', deviceLocale);
    } catch (e) {
      console.warn('⚠️ Could not get locale from Intl API:', e);
    }
    
    // Method 2: Try React Native NativeModules (platform-specific)
    if (!deviceLocale) {
      try {
        const { NativeModules } = require('react-native');
        
        if (Platform.OS === 'ios') {
          // iOS: Try multiple possible locations
          deviceLocale = NativeModules.SettingsManager?.settings?.AppleLocale || 
                         NativeModules.SettingsManager?.settings?.AppleLanguages?.[0] ||
                         null;
        } else if (Platform.OS === 'android') {
          // Android: Use I18nManager
          deviceLocale = NativeModules.I18nManager?.localeIdentifier || null;
        }
        
        if (deviceLocale) {
          console.log('🌍 Got locale from NativeModules:', deviceLocale);
        }
      } catch (e) {
        console.warn('⚠️ Could not get locale from NativeModules:', e);
      }
    }
    
    if (!deviceLocale) {
      console.log('🌍 No device locale found');
      return null;
    }
    
    console.log('🌍 Device locale:', deviceLocale);
    
    // Extract language code (e.g., "en-US" -> "en", "zh-Hans" -> "zh", "zh-Hans-CN" -> "zh")
    const languageCode = deviceLocale.split('-')[0].toLowerCase();
    
    // Check if it's a supported locale
    if (SUPPORTED_LOCALES.includes(languageCode as SupportedLocale)) {
      console.log('🌍 Matched device locale:', languageCode);
      return languageCode as SupportedLocale;
    }
    
    // Try full locale match (e.g., "de-DE", "it-IT", "zh-CN", "ja-JP", "pt-BR", "fr-FR", "es-ES")
    const lowerLocale = deviceLocale.toLowerCase();
    for (const locale of SUPPORTED_LOCALES) {
      if (lowerLocale.startsWith(locale + '-') || lowerLocale === locale) {
        console.log('🌍 Matched device locale (full code):', locale);
        return locale;
      }
    }
    
    // Special handling for Chinese variants
    if (lowerLocale.includes('zh')) {
      if (lowerLocale.includes('hans') || lowerLocale.includes('cn') || lowerLocale.includes('sg')) {
        console.log('🌍 Matched Chinese (Simplified)');
        return 'zh';
      }
      if (lowerLocale.includes('hant') || lowerLocale.includes('tw') || lowerLocale.includes('hk') || lowerLocale.includes('mo')) {
        console.log('🌍 Matched Chinese (Traditional) -> using zh');
        return 'zh';
      }
    }
    
    // Special handling for Portuguese variants
    if (lowerLocale.includes('pt')) {
      if (lowerLocale.includes('br')) {
        console.log('🌍 Matched Portuguese (Brazilian)');
        return 'pt';
      }
      if (lowerLocale.startsWith('pt-')) {
        console.log('🌍 Matched Portuguese');
        return 'pt';
      }
    }
    
    console.log('🌍 No supported locale match found for device locale');
    return null;
  } catch (error) {
    console.warn('⚠️ Failed to detect locale from device:', error);
    return null;
  }
}

/**
 * Gets the best locale match based on multiple detection methods
 * Priority: device locale > timezone > default
 */
export function detectBestLocale(): SupportedLocale {
  // Try device locale first (most accurate - user's explicit setting)
  const deviceLocale = detectLocaleFromDevice();
  if (deviceLocale) {
    console.log('✅ Using device locale:', deviceLocale);
    return deviceLocale;
  }
  
  // Fallback to timezone detection
  const timezoneLocale = detectLocaleFromTimezone();
  if (timezoneLocale) {
    console.log('✅ Using timezone-detected locale:', timezoneLocale);
    return timezoneLocale;
  }
  
  // Default fallback
  console.log('🌍 Using default locale:', DEFAULT_LOCALE);
  return DEFAULT_LOCALE;
}

