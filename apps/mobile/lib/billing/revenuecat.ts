import Purchases, {
  LOG_LEVEL,
  PurchasesOffering,
  PurchasesPackage,
  CustomerInfo,
  PurchasesStoreProduct,
} from 'react-native-purchases';
import { Platform } from 'react-native';
import { API_URL, getAuthHeaders } from '@/api/config';

const REVENUECAT_API_KEY_IOS = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY || '';
const REVENUECAT_API_KEY_ANDROID = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY || '';

export interface RevenueCatProduct {
  identifier: string;
  description: string;
  title: string;
  price: number;
  priceString: string;
  currencyCode: string;
  introPrice?: {
    price: number;
    priceString: string;
    period: string;
  };
}

export interface RevenueCatSubscriptionInfo {
  isActive: boolean;
  willRenew: boolean;
  periodType: 'normal' | 'trial' | 'intro';
  expirationDate?: string;
  productIdentifier?: string;
  isSandbox: boolean;
}

let isConfigured = false;

export async function setRevenueCatAttributes(email?: string, displayName?: string, phoneNumber?: string): Promise<void> {
  try {
    if (email) {
      await Purchases.setEmail(email);
    }
    if (displayName) {
      await Purchases.setDisplayName(displayName);
    }
    if (phoneNumber) {
      await Purchases.setPhoneNumber(phoneNumber);
    }
  } catch (error) {
    console.error('❌ Error setting RevenueCat attributes:', error);
  }
}

export async function initializeRevenueCat(userId: string, email?: string): Promise<void> {
  if (isConfigured) {
    console.log('🔄 RevenueCat already configured, updating user...');
    try {
      const { customerInfo } = await Purchases.logIn(userId);
      if (email) {
        console.log('📧 Setting email for existing RevenueCat customer:', email);
        await Purchases.setEmail(email);
        console.log('✅ Email set successfully:', email);
      }
      return;
    } catch (error) {
      console.error('❌ Error logging in to RevenueCat:', error);
      throw error;
    }
  }

  const apiKey = Platform.OS === 'ios' ? REVENUECAT_API_KEY_IOS : REVENUECAT_API_KEY_ANDROID;
  
  if (!apiKey) {
    throw new Error('RevenueCat API key not configured');
  }

  try {
    console.log('🚀 Initializing RevenueCat...');
    console.log('👤 User ID:', userId);
    console.log('📧 Email:', email || 'No email provided');
    
    if (__DEV__) {
      Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    }

    Purchases.configure({ apiKey, appUserID: userId });
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (email) {
      console.log('📧 Setting email for RevenueCat customer:', email);
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email set successfully:', email);
      } catch (emailError) {
        console.error('❌ Error setting email:', emailError);
      }
    } else {
      console.warn('⚠️ No email provided to RevenueCat');
    }
    
    Purchases.addCustomerInfoUpdateListener((customerInfo) => {
      console.log('📱 Customer info updated:', customerInfo);
      notifyBackendOfPurchase(customerInfo);
    });

    isConfigured = true;
    console.log('✅ RevenueCat initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing RevenueCat:', error);
    throw error;
  }
}

export async function getOfferings(): Promise<PurchasesOffering | null> {
  try {
    const offerings = await Purchases.getOfferings();
    
    if (offerings.current) {
      console.log('✅ Current offering:', offerings.current.identifier);
      return offerings.current;
    }
    
    console.warn('⚠️ No current offering available');
    return null;
  } catch (error) {
    console.error('❌ Error fetching offerings:', error);
    throw error;
  }
}

export async function purchasePackage(pkg: PurchasesPackage, email?: string): Promise<CustomerInfo> {
  try {
    console.log('💳 Purchasing package:', pkg.identifier);
    
    if (email) {
      console.log('📧 Ensuring email is set before purchase:', email);
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email confirmed before purchase');
      } catch (emailError) {
        console.warn('⚠️ Could not set email before purchase:', emailError);
      }
    }
    
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    
    console.log('✅ Purchase successful');
    console.log('📊 Customer Info - Original App User ID:', customerInfo.originalAppUserId);
    
    await notifyBackendOfPurchase(customerInfo);
    
    return customerInfo;
  } catch (error: any) {
    if (error.userCancelled) {
      console.log('🚫 User cancelled purchase');
    } else {
      console.error('❌ Purchase error:', error);
    }
    throw error;
  }
}

export async function restorePurchases(email?: string): Promise<CustomerInfo> {
  try {
    console.log('🔄 Restoring purchases...');
    if (email) {
      console.log('📧 Setting email before restore:', email);
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email set successfully');
      } catch (emailError) {
        console.warn('⚠️ Could not set email before restore:', emailError);
      }
    }
    
    const customerInfo = await Purchases.restorePurchases();
    
    console.log('✅ Purchases restored');
    console.log('📊 Active subscriptions:', customerInfo.activeSubscriptions);
    console.log('📊 Active entitlements:', Object.keys(customerInfo.entitlements.active));
    
    await notifyBackendOfPurchase(customerInfo);
    
    return customerInfo;
  } catch (error) {
    console.error('❌ Error restoring purchases:', error);
    throw error;
  }
}

export async function getCustomerInfo(): Promise<CustomerInfo> {
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    return customerInfo;
  } catch (error) {
    console.error('❌ Error fetching customer info:', error);
    throw error;
  }
}

export function getSubscriptionInfo(customerInfo: CustomerInfo): RevenueCatSubscriptionInfo {
  const entitlements = customerInfo.entitlements.active;
  const hasActiveEntitlement = Object.keys(entitlements).length > 0;
  
  if (!hasActiveEntitlement) {
    return {
      isActive: false,
      willRenew: false,
      periodType: 'normal',
      isSandbox: customerInfo.requestDate !== undefined,
    };
  }

  const activeEntitlement = Object.values(entitlements)[0];
  
  return {
    isActive: true,
    willRenew: activeEntitlement.willRenew,
    periodType: activeEntitlement.periodType as 'normal' | 'trial' | 'intro',
    expirationDate: activeEntitlement.expirationDate || undefined,
    productIdentifier: activeEntitlement.productIdentifier,
    isSandbox: customerInfo.requestDate !== undefined,
  };
}

async function notifyBackendOfPurchase(customerInfo: CustomerInfo): Promise<void> {
  try {
    console.log('📤 Notifying backend of purchase...');
    
    const headers = await getAuthHeaders();
    
    const response = await fetch(`${API_URL}/billing/revenuecat/sync`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer_info: {
          original_app_user_id: customerInfo.originalAppUserId,
          entitlements: Object.keys(customerInfo.entitlements.active),
          active_subscriptions: customerInfo.activeSubscriptions,
          non_subscriptions: customerInfo.nonSubscriptionTransactions,
        },
      }),
    });

    if (!response.ok) {
      console.warn('⚠️ Backend notification failed:', response.status);
    } else {
      console.log('✅ Backend notified successfully');
    }
  } catch (error) {
    console.error('❌ Error notifying backend:', error);
  }
}

export async function checkSubscriptionStatus(): Promise<{
  hasActiveSubscription: boolean;
  tier?: string;
  expirationDate?: string;
}> {
  try {
    const customerInfo = await getCustomerInfo();
    const subscriptionInfo = getSubscriptionInfo(customerInfo);
    
    if (!subscriptionInfo.isActive) {
      return { hasActiveSubscription: false };
    }

    let tier = 'free';
    if (subscriptionInfo.productIdentifier?.includes('pro')) {
      tier = 'pro';
    } else if (subscriptionInfo.productIdentifier?.includes('team')) {
      tier = 'team';
    } else if (subscriptionInfo.productIdentifier?.includes('enterprise')) {
      tier = 'enterprise';
    }

    return {
      hasActiveSubscription: true,
      tier,
      expirationDate: subscriptionInfo.expirationDate,
    };
  } catch (error) {
    console.error('❌ Error checking subscription status:', error);
    return { hasActiveSubscription: false };
  }
}

export async function presentPaywall(): Promise<void> {
  try {
    const offerings = await getOfferings();
    if (!offerings) {
      throw new Error('No offerings available to display');
    }
    console.log('📱 Presenting paywall with offerings');
    return;
  } catch (error) {
    console.error('❌ Error presenting paywall:', error);
    throw error;
  }
}

