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
let initializationPromise: Promise<void> | null = null;
let customerInfoListenerAdded = false;

async function isRevenueCatAlreadyConfigured(): Promise<boolean> {
  try {
    // Try to get customer info - if this succeeds, RevenueCat is already configured
    await Purchases.getCustomerInfo();
    return true;
  } catch {
    return false;
  }
}

export async function logoutRevenueCat(): Promise<void> {
  try {
    console.log('🚪 Logging out from RevenueCat...');
    const customerInfo = await Purchases.getCustomerInfo();
    const wasAnonymous = customerInfo.originalAppUserId.startsWith('$RCAnonymousID:');
    await Purchases.logOut();
    isConfigured = false;
    initializationPromise = null;
    customerInfoListenerAdded = false;
    console.log('✅ RevenueCat logout successful');
    console.log(`🔓 ${wasAnonymous ? 'Anonymous' : 'User'} subscription detached from device`);
  } catch (error) {
    console.error('❌ Error logging out from RevenueCat:', error);
    isConfigured = false;
    initializationPromise = null;
    customerInfoListenerAdded = false;
  }
}

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

export async function initializeRevenueCat(userId: string, email?: string, canTrack: boolean = false): Promise<void> {
  // If already configured, just update email if needed and return
  if (isConfigured || (await isRevenueCatAlreadyConfigured())) {
    console.log('ℹ️ RevenueCat already configured, updating attributes if needed...');
    isConfigured = true;
    
    // Update email if provided and tracking is enabled
    if (email && canTrack) {
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email updated:', email);
      } catch (emailError) {
        console.warn('⚠️ Could not update email:', emailError);
      }
    }
    
    // Add listener if tracking is enabled and listener hasn't been added yet
    if (canTrack && !customerInfoListenerAdded) {
      Purchases.addCustomerInfoUpdateListener((customerInfo) => {
        console.log('📱 Customer info updated:', customerInfo);
        notifyBackendOfPurchase(customerInfo);
      });
      customerInfoListenerAdded = true;
      console.log('✅ Customer info update listener added');
    }
    
    // Update user ID if it changed
    try {
      const currentInfo = await Purchases.getCustomerInfo();
      if (currentInfo.originalAppUserId !== userId) {
        console.log('🔄 User ID changed, logging in with new ID...');
        await Purchases.logIn(userId);
        console.log('✅ User ID updated successfully');
      }
    } catch (error) {
      console.warn('⚠️ Could not update user ID:', error);
    }
    
    return;
  }

  // If initialization is in progress, wait for it to complete
  if (initializationPromise) {
    console.log('⏳ RevenueCat initialization already in progress, waiting...');
    await initializationPromise;
    return;
  }

  const apiKey = Platform.OS === 'ios' ? REVENUECAT_API_KEY_IOS : REVENUECAT_API_KEY_ANDROID;
  
  if (!apiKey) {
    throw new Error('RevenueCat API key not configured');
  }

  // Create a promise that will be shared by concurrent calls
  initializationPromise = (async () => {
  try {
    console.log('🚀 Initializing RevenueCat...');
    console.log('👤 User ID:', userId);
    console.log('📧 Email:', email || 'No email provided');
    console.log('📊 Tracking allowed:', canTrack);
    
    if (__DEV__) {
      Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    }

    Purchases.configure({ apiKey, appUserID: userId });
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (email && canTrack) {
      console.log('📧 Setting email for RevenueCat customer (tracking enabled):', email);
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email set successfully:', email);
      } catch (emailError) {
        console.error('❌ Error setting email:', emailError);
      }
    } else if (!canTrack) {
      console.log('⚠️ Tracking disabled - email not set for analytics');
    } else {
      console.warn('⚠️ No email provided to RevenueCat');
    }
    
      if (canTrack && !customerInfoListenerAdded) {
      Purchases.addCustomerInfoUpdateListener((customerInfo) => {
        console.log('📱 Customer info updated:', customerInfo);
        notifyBackendOfPurchase(customerInfo);
      });
        customerInfoListenerAdded = true;
        console.log('✅ Customer info update listener added');
      } else if (!canTrack) {
        console.log('⚠️ Analytics listener not added (tracking disabled)');
    } else {
        console.log('ℹ️ Customer info listener already added');
    }

    isConfigured = true;
    console.log('✅ RevenueCat initialized successfully');
    console.log('🔒 SECURITY: Subscription is now locked to this account');
  } catch (error) {
    console.error('❌ Error initializing RevenueCat:', error);
      isConfigured = false;
      initializationPromise = null;
    throw error;
  }
  })();

  await initializationPromise;
}

export async function getOfferings(forceRefresh: boolean = false): Promise<PurchasesOffering | null> {
  try {
    if (forceRefresh) {
      console.log('🔄 Forcing fresh offerings fetch from RevenueCat...');
      try {
        const currentAppUserId = (await Purchases.getCustomerInfo()).originalAppUserId;
        console.log('🔄 Resetting SDK to clear cache...');
        
        await Purchases.invalidateCustomerInfoCache();
        await Purchases.syncPurchases();
        
        if (!currentAppUserId.startsWith('$RCAnonymousID:')) {
          await Purchases.logOut();
          await Purchases.logIn(currentAppUserId);
          console.log('✅ SDK reset completed with logout/login cycle');
        } else {
          console.log('⚠️ User is anonymous, skipping logout/login cycle');
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (resetError) {
        console.warn('⚠️ Cache reset failed, continuing with getOfferings:', resetError);
      }
    }
    
    const offerings = await Purchases.getOfferings();
    
    if (offerings.current) {
      console.log('✅ Current offering:', offerings.current.identifier);
      console.log('📦 Available packages:', offerings.current.availablePackages.map(p => p.identifier).join(', '));
      return offerings.current;
    }
    
    console.warn('⚠️ No current offering available');
    return null;
  } catch (error) {
    console.error('❌ Error fetching offerings:', error);
    throw error;
  }
}

export async function getOfferingById(offeringId: string, forceRefresh: boolean = false): Promise<PurchasesOffering | null> {
  try {
    if (forceRefresh) {
      console.log(`🔄 Forcing fresh fetch for offering: ${offeringId}...`);
      try {
        const currentAppUserId = (await Purchases.getCustomerInfo()).originalAppUserId;
        console.log('🔄 Resetting SDK to clear cache...');
        
        await Purchases.invalidateCustomerInfoCache();
        await Purchases.syncPurchases();
        
        if (!currentAppUserId.startsWith('$RCAnonymousID:')) {
          await Purchases.logOut();
          await Purchases.logIn(currentAppUserId);
          console.log('✅ SDK reset completed with logout/login cycle');
        } else {
          console.log('⚠️ User is anonymous, skipping logout/login cycle');
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (resetError) {
        console.warn('⚠️ Cache reset failed, continuing with getOfferings:', resetError);
      }
    }
    
    const offerings = await Purchases.getOfferings();
    const offering = offerings.all[offeringId];
    
    if (offering) {
      console.log(`✅ Found offering: ${offeringId}`);
      console.log('📦 Available packages:', offering.availablePackages.map(p => p.identifier).join(', '));
      return offering;
    }
    
    console.warn(`⚠️ Offering '${offeringId}' not found. Available offerings:`, Object.keys(offerings.all));
    return null;
  } catch (error) {
    console.error(`❌ Error fetching offering '${offeringId}':`, error);
    throw error;
  }
}

export async function purchasePackage(pkg: PurchasesPackage, email?: string): Promise<CustomerInfo> {
  try {
    console.log('💳 Purchasing package:', pkg.identifier);
    
    const isOneTimePurchase = pkg.identifier.toLowerCase().includes('topup') || 
                              pkg.identifier.toLowerCase().includes('credit');
    
    const currentCustomerInfo = await Purchases.getCustomerInfo();
    
    const hasActiveSubscription = 
      Object.keys(currentCustomerInfo.entitlements.active).length > 0 ||
      currentCustomerInfo.activeSubscriptions.length > 0;

    if (hasActiveSubscription && !isOneTimePurchase) {
      const activeProductIds = currentCustomerInfo.activeSubscriptions;
      console.log('🚫 BLOCKING PURCHASE - Device already has active subscription:', activeProductIds);
      console.log('🔒 Security: Preventing subscription sharing/transfer abuse');
      
      const error: any = new Error(
        'This device already has an active subscription. Please use "Restore Purchases" to access your existing subscription.'
      );
      error.code = 'SUBSCRIPTION_ALREADY_EXISTS';
      error.userCancelled = false;
      throw error;
    }
    
    if (isOneTimePurchase) {
      console.log('💰 One-time credit purchase detected - bypassing subscription guard');
    }
    
    if (email) {
      console.log('📧 Ensuring email is set before purchase:', email);
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email confirmed before purchase');
      } catch (emailError) {
        console.warn('⚠️ Could not set email before purchase:', emailError);
      }
    }
    
    let customerInfo: CustomerInfo;
    try {
      const result = await Purchases.purchasePackage(pkg);
      customerInfo = result.customerInfo;
    } catch (purchaseError: any) {
      // RevenueCat logs purchase cancellations as errors internally, but they're not real errors
      // Check for user cancellation using multiple possible indicators
      const isUserCancelled = 
        purchaseError.userCancelled === true ||
        purchaseError.code === 'PURCHASE_CANCELLED' ||
        purchaseError.code === 'USER_CANCELLED' ||
        purchaseError.code === 'PURCHASES_ERROR' && purchaseError.underlyingErrorMessage?.includes('cancelled') ||
        (purchaseError.message && purchaseError.message.toLowerCase().includes('cancelled')) ||
        (purchaseError.underlyingErrorMessage && purchaseError.underlyingErrorMessage.toLowerCase().includes('cancelled'));

      if (isUserCancelled) {
        // User cancellation is expected behavior - create a clean error without stack trace issues
        console.log('🚫 User cancelled purchase');
        const cancelledError: any = Error('Purchase was cancelled by user');
        cancelledError.userCancelled = true;
        cancelledError.code = 'USER_CANCELLED';
        cancelledError.name = 'PurchaseCancelledError';
        // Prevent stack trace issues by not including the original error
        throw cancelledError;
      }
      // Re-throw other errors as-is
      throw purchaseError;
    }
    
    console.log('✅ Purchase successful');
    console.log('📊 Customer Info - Original App User ID:', customerInfo.originalAppUserId);
    
    await notifyBackendOfPurchase(customerInfo);
    
    return customerInfo;
  } catch (error: any) {
    // Final error handling - check again in case error was re-thrown
    if (error.userCancelled || error.code === 'USER_CANCELLED') {
      console.log('🚫 User cancelled purchase');
      // Don't log as error - it's expected behavior
    } else {
      console.error('❌ Purchase error:', error);
    }
    throw error;
  }
}

export async function restorePurchases(email?: string): Promise<CustomerInfo> {
  try {
    console.log('🔄 Restoring purchases...');
    console.warn('⚠️ SECURITY WARNING: Restore will link this Apple ID subscription to current account');
    console.warn('⚠️ Backend will validate transfer - only allows if emails match');
    console.warn('⚠️ Transfer between different user accounts will be BLOCKED');
    
    if (email) {
      console.log('📧 Setting email before restore:', email);
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email set successfully - needed for backend validation');
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

    if (response.status === 403) {
      console.log('ℹ️ Sync rejected - waiting for webhook validation');
      console.log('📡 New subscriptions are processed via webhooks for security');
      console.log('⏳ Your subscription will be activated within 30 seconds once validated');
    } else if (!response.ok) {
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
    const offerings = await getOfferings(true);
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
