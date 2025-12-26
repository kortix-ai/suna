/**
 * Utility functions for detecting actual mobile devices (not just viewport size)
 * These use userAgent detection for actual phone/tablet detection
 */

export type MobileDevicePlatform = 'ios' | 'android' | null;

/**
 * Detect if the current device is an actual mobile device (iPhone, iPad, Android)
 * using userAgent detection - NOT viewport-based detection
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  
  const userAgent = window.navigator.userAgent.toLowerCase();
  
  // Check for iOS devices
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return true;
  }
  
  // Check for Android devices
  if (/android/.test(userAgent)) {
    return true;
  }
  
  return false;
}

/**
 * Detect the specific mobile platform (iOS or Android)
 * Returns null if not a mobile device
 */
export function getMobileDevicePlatform(): MobileDevicePlatform {
  if (typeof window === 'undefined') return null;
  
  const userAgent = window.navigator.userAgent.toLowerCase();
  
  // Check for iOS devices
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return 'ios';
  }
  
  // Check for Android devices
  if (/android/.test(userAgent)) {
    return 'android';
  }
  
  return null;
}

/**
 * Check if the device is specifically an iPhone (not iPad)
 */
export function isIPhone(): boolean {
  if (typeof window === 'undefined') return false;
  return /iphone/.test(window.navigator.userAgent.toLowerCase());
}

/**
 * Check if the device is an iPad
 */
export function isIPad(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = window.navigator.userAgent.toLowerCase();
  // Also check for Mac with touch for iPad OS 13+
  return /ipad/.test(userAgent) || 
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Check if the device is specifically an Android phone (not tablet)
 * This is a heuristic based on screen size
 */
export function isAndroidPhone(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = window.navigator.userAgent.toLowerCase();
  // Android phones typically have "mobile" in userAgent, tablets don't
  return /android/.test(userAgent) && /mobile/.test(userAgent);
}

/**
 * Check if the device is an Android tablet
 */
export function isAndroidTablet(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = window.navigator.userAgent.toLowerCase();
  // Android tablets typically don't have "mobile" in userAgent
  return /android/.test(userAgent) && !/mobile/.test(userAgent);
}

/**
 * Store links for mobile app downloads
 */
export const MOBILE_APP_STORE_LINKS = {
  ios: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  android: 'https://play.google.com/store/apps/details?id=com.kortix.app',
} as const;

/**
 * Deep link scheme for opening the Kortix app
 */
export const KORTIX_DEEP_LINK = 'kortix://';

