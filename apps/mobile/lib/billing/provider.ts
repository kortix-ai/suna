import { Platform } from 'react-native';

export type BillingProvider = 'stripe' | 'revenuecat' | 'none';

export function getBillingProvider(): BillingProvider {
  // RevenueCat doesn't support web platform
  if (Platform.OS === 'web') {
    return 'stripe';
  }

  const useRevenueCat = process.env.EXPO_PUBLIC_USE_REVENUECAT === 'true';
  if (useRevenueCat) {
    return 'revenuecat';
  }
  return 'stripe';
}

export function shouldUseRevenueCat(): boolean {
  // RevenueCat doesn't support web platform
  if (Platform.OS === 'web') {
    return false;
  }
  return getBillingProvider() === 'revenuecat';
}

export function shouldUseStripe(): boolean {
  return getBillingProvider() === 'stripe';
}

export function isRevenueCatConfigured(): boolean {
  const hasIosKey = !!process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
  const hasAndroidKey = !!process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  return hasIosKey || hasAndroidKey;
}
