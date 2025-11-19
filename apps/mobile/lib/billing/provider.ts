export type BillingProvider = 'stripe' | 'revenuecat' | 'none';

export function getBillingProvider(): BillingProvider {
  const useRevenueCat = process.env.EXPO_PUBLIC_USE_REVENUECAT === 'true';
  if (useRevenueCat) {
    return 'revenuecat';
  }
  return 'stripe';
}

export function shouldUseRevenueCat(): boolean {
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
