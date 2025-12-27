import Purchases, {
  PurchasesOffering,
  PurchasesPackage,
  CustomerInfo,
  PurchasesStoreProduct,
  LOG_LEVEL,
} from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';
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
let lastSetEmail: string | null = null;
let lastSetUserId: string | null = null;
let currentInitializationParams: { userId: string; email?: string; canTrack: boolean } | null =
  null;
/**
 * Ensures the RevenueCat log handler is set.
 * This must be called before any SDK operations to prevent "customLogHandler is not a function" errors.
 * Safe to call multiple times - setLogHandler can be called repeatedly.
 * 
 * IMPORTANT: This should be called after logout/login cycles as the SDK may reset the handler.
 */
function ensureLogHandler(): void {
  try {
    Purchases.setLogHandler((logLevel, message) => {
      switch (logLevel) {
        case LOG_LEVEL.VERBOSE:
          console.debug('[RC Verbose]', message);
          break;
        case LOG_LEVEL.DEBUG:
          console.debug('[RC Debug]', message);
          break;
        case LOG_LEVEL.INFO:
          console.info('[RC Info]', message);
          break;
        case LOG_LEVEL.WARN:
          console.warn('[RC Warn]', message);
          break;
        case LOG_LEVEL.ERROR:
          console.error('[RC Error]', message);
          break;
      }
    });
  } catch (error) {
    // If setting log handler fails, log it but don't throw - SDK might already be configured
    // This can happen if the SDK isn't initialized yet, which is fine
    console.warn('⚠️ Could not set RevenueCat log handler (SDK may not be initialized yet):', error);
  }
}

async function isRevenueCatAlreadyConfigured(): Promise<boolean> {
  try {
    // Ensure log handler is set before any SDK operations
    ensureLogHandler();
    // Try to get customer info - if this succeeds, RevenueCat is already configured
    await Purchases.getCustomerInfo();
    return true;
  } catch {
    return false;
  }
}

export async function logoutRevenueCat(): Promise<void> {
  try {
    // Ensure log handler is set before any SDK operations
    ensureLogHandler();
    
    console.log('🚪 Logging out from RevenueCat...');
    const customerInfo = await Purchases.getCustomerInfo();
    const wasAnonymous = customerInfo.originalAppUserId.startsWith('$RCAnonymousID:');
    await Purchases.logOut();
    isConfigured = false;
    initializationPromise = null;
    customerInfoListenerAdded = false;
    lastSetEmail = null;
    lastSetUserId = null;
    currentInitializationParams = null;
    console.log('✅ RevenueCat logout successful');
    console.log(`🔓 ${wasAnonymous ? 'Anonymous' : 'User'} subscription detached from device`);
  } catch (error) {
    console.error('❌ Error logging out from RevenueCat:', error);
    isConfigured = false;
    initializationPromise = null;
    customerInfoListenerAdded = false;
    lastSetEmail = null;
    lastSetUserId = null;
    currentInitializationParams = null;
  }
}

export async function setRevenueCatAttributes(
  email?: string,
  displayName?: string,
  phoneNumber?: string
): Promise<void> {
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

export async function initializeRevenueCat(
  userId: string,
  email?: string,
  canTrack: boolean = false
): Promise<void> {
  // Check if we're already initializing with the same parameters
  if (
    currentInitializationParams &&
    currentInitializationParams.userId === userId &&
    currentInitializationParams.email === email &&
    currentInitializationParams.canTrack === canTrack
  ) {
    // Same initialization already in progress, wait for it
    if (initializationPromise) {
      await initializationPromise;
    }
    return;
  }

  // If already configured, just update email if needed and return
  if (isConfigured || (await isRevenueCatAlreadyConfigured())) {
    isConfigured = true;

    // Update email if provided, tracking is enabled, and email actually changed
    if (email && canTrack && email !== lastSetEmail) {
      try {
        await Purchases.setEmail(email);
        console.log('✅ Email updated:', email);
        lastSetEmail = email;
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
    if (userId !== lastSetUserId) {
      try {
        const currentInfo = await Purchases.getCustomerInfo();
        if (currentInfo.originalAppUserId !== userId) {
          console.log('🔄 User ID changed, logging in with new ID...');
          await Purchases.logIn(userId);
          console.log('✅ User ID updated successfully');
          lastSetUserId = userId;
        } else {
          // User ID matches, just track it
          lastSetUserId = userId;
        }
      } catch (error) {
        console.warn('⚠️ Could not update user ID:', error);
      }
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

  // Track current initialization parameters
  currentInitializationParams = { userId, email, canTrack };

  // Create a promise that will be shared by concurrent calls
  initializationPromise = (async () => {
    try {
      console.log('🚀 Initializing RevenueCat...');
      console.log('👤 User ID:', userId);
      console.log('📧 Email:', email || 'No email provided');
      console.log('📊 Tracking allowed:', canTrack);

      // Ensure log handler is set before configure() to prevent "customLogHandler is not a function" errors
      ensureLogHandler();

      Purchases.configure({ apiKey, appUserID: userId });

      await new Promise((resolve) => setTimeout(resolve, 100));

      if (email && canTrack) {
        console.log('📧 Setting email for RevenueCat customer (tracking enabled):', email);
        try {
          await Purchases.setEmail(email);
          console.log('✅ Email set successfully:', email);
          lastSetEmail = email;
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
      lastSetUserId = userId;
      currentInitializationParams = null;
      console.log('✅ RevenueCat initialized successfully');
      console.log('🔒 SECURITY: Subscription is now locked to this account');
    } catch (error) {
      console.error('❌ Error initializing RevenueCat:', error);
      isConfigured = false;
      initializationPromise = null;
      currentInitializationParams = null;
      throw error;
    }
  })();

  await initializationPromise;
  currentInitializationParams = null;
}

export async function getOfferings(
  forceRefresh: boolean = false
): Promise<PurchasesOffering | null> {
  try {
    // Ensure log handler is set before any SDK operations
    ensureLogHandler();
    
    if (forceRefresh) {
      console.log('🔄 Forcing fresh offerings fetch from RevenueCat...');
      try {
        const currentAppUserId = (await Purchases.getCustomerInfo()).originalAppUserId;
        console.log('🔄 Resetting SDK to clear cache...');

        await Purchases.invalidateCustomerInfoCache();
        await Purchases.syncPurchases();

        if (!currentAppUserId.startsWith('$RCAnonymousID:')) {
          await Purchases.logOut();
          // Re-set log handler after logout/login as it might be reset
          ensureLogHandler();
          await Purchases.logIn(currentAppUserId);
          console.log('✅ SDK reset completed with logout/login cycle');
        } else {
          console.log('⚠️ User is anonymous, skipping logout/login cycle');
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (resetError) {
        console.warn('⚠️ Cache reset failed, continuing with getOfferings:', resetError);
      }
    }

    const offerings = await Purchases.getOfferings();

    if (offerings.current) {
      console.log('✅ Current offering:', offerings.current.identifier);
      console.log(
        '📦 Available packages:',
        offerings.current.availablePackages.map((p) => p.identifier).join(', ')
      );
      console.log(
        '📦 Available product IDs:',
        offerings.current.availablePackages.map((p) => p.product.identifier).join(', ')
      );
      return offerings.current;
    }

    console.warn('⚠️ No current offering available');
    return null;
  } catch (error) {
    console.error('❌ Error fetching offerings:', error);
    throw error;
  }
}

export async function getOfferingById(
  offeringId: string,
  forceRefresh: boolean = false
): Promise<PurchasesOffering | null> {
  try {
    // Ensure log handler is set before any SDK operations
    ensureLogHandler();
    
    if (forceRefresh) {
      console.log(`🔄 Forcing fresh fetch for offering: ${offeringId}...`);
      try {
        const currentAppUserId = (await Purchases.getCustomerInfo()).originalAppUserId;
        console.log('🔄 Resetting SDK to clear cache...');

        await Purchases.invalidateCustomerInfoCache();
        await Purchases.syncPurchases();

        if (!currentAppUserId.startsWith('$RCAnonymousID:')) {
          await Purchases.logOut();
          // Re-set log handler after logout/login as it might be reset
          ensureLogHandler();
          await Purchases.logIn(currentAppUserId);
          console.log('✅ SDK reset completed with logout/login cycle');
        } else {
          console.log('⚠️ User is anonymous, skipping logout/login cycle');
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (resetError) {
        console.warn('⚠️ Cache reset failed, continuing with getOfferings:', resetError);
      }
    }

    const offerings = await Purchases.getOfferings();
    
    // Log all available offerings for debugging
    const availableOfferingIds = Object.keys(offerings.all);
    console.log(`📦 All available offerings: ${availableOfferingIds.join(', ') || 'none'}`);
    console.log(`📦 Current offering: ${offerings.current?.identifier || 'none'}`);
    
    const offering = offerings.all[offeringId];

    if (offering) {
      console.log(`✅ Found offering: ${offeringId}`);
      console.log(
        '📦 Available packages:',
        offering.availablePackages.map((p) => p.identifier).join(', ')
      );
      return offering;
    }

    // More helpful error message when offering is not found
    const errorMessage = `Offering '${offeringId}' not found in RevenueCat. Available offerings: ${availableOfferingIds.join(', ') || 'none'}. Please check your RevenueCat dashboard configuration.`;
    console.warn(`⚠️ ${errorMessage}`);
    
    // Create a more descriptive error
    const error: any = new Error(errorMessage);
    error.code = 'OFFERING_NOT_FOUND';
    error.availableOfferings = availableOfferingIds;
    throw error;
  } catch (error: any) {
    // Improve error messages for configuration issues
    if (error?.message?.includes('configuration') || error?.code === 'CONFIGURATION_ERROR') {
      const errorMessage = `RevenueCat configuration error for offering '${offeringId}'. This usually means:
1. The offering '${offeringId}' doesn't exist in your RevenueCat dashboard
2. The offering exists but has no packages configured
3. The products in the offering are not properly configured in App Store Connect / Google Play Console

Please check your RevenueCat dashboard and ensure the offering is properly configured.`;
      console.error(`❌ ${errorMessage}`);
      const configError: any = new Error(errorMessage);
      configError.code = 'CONFIGURATION_ERROR';
      configError.originalError = error;
      throw configError;
    }
    
    console.error(`❌ Error fetching offering '${offeringId}':`, error);
    throw error;
  }
}

export async function purchasePackage(
  pkg: PurchasesPackage,
  email?: string,
  expectedUserId?: string,
  onSyncComplete?: (response: SyncResponse) => void | Promise<void>
): Promise<CustomerInfo> {
  try {
    // Ensure log handler is set before any SDK operations
    ensureLogHandler();
    
    console.log('💳 Purchasing package:', pkg.identifier);

    // CRITICAL: Verify RevenueCat is linked to the correct user before purchase
    let currentCustomerInfo = await Purchases.getCustomerInfo();
    let rcUserId = currentCustomerInfo.originalAppUserId;

    console.log('🔐 RevenueCat User ID:', rcUserId);
    console.log('🔐 Expected User ID:', expectedUserId);

    // If RevenueCat is anonymous or mismatched, try to fix it
    const isAnonymous = rcUserId.startsWith('$RCAnonymousID:');
    const isMismatched = expectedUserId && rcUserId !== expectedUserId;

    if ((isAnonymous || isMismatched) && expectedUserId) {
      console.log('🔄 RevenueCat session mismatch - attempting to fix...');
      try {
        // Try to log in with the correct user ID
        // Re-set log handler after login as it might be reset
        ensureLogHandler();
        const loginResult = await Purchases.logIn(expectedUserId);
        currentCustomerInfo = loginResult.customerInfo;
        rcUserId = currentCustomerInfo.originalAppUserId;
        console.log('✅ RevenueCat session fixed, new user ID:', rcUserId);

        // Check if this Apple ID already has an active subscription
        const hasActiveSubscription =
          Object.keys(currentCustomerInfo.entitlements.active).length > 0 ||
          currentCustomerInfo.activeSubscriptions.length > 0;

        if (hasActiveSubscription) {
          console.log('⚠️ This Apple ID already has an active subscription on another account');
          const error: any = new Error('You are already subscribed with a different account.');
          error.code = 'ALREADY_SUBSCRIBED_DIFFERENT_ACCOUNT';
          error.userCancelled = false;
          throw error;
        }
      } catch (loginError: any) {
        // If login failed and it's not the "already subscribed" error, throw session error
        if (loginError.code === 'ALREADY_SUBSCRIBED_DIFFERENT_ACCOUNT') {
          throw loginError;
        }
        console.error('❌ Failed to fix RevenueCat session:', loginError);
        const error: any = new Error(
          'Unable to link your account. Please restart the app and try again.'
        );
        error.code = 'SESSION_FIX_FAILED';
        error.userCancelled = false;
        throw error;
      }
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
        (purchaseError.code === 'PURCHASES_ERROR' &&
          purchaseError.underlyingErrorMessage?.includes('cancelled')) ||
        (purchaseError.message && purchaseError.message.toLowerCase().includes('cancelled')) ||
        (purchaseError.underlyingErrorMessage &&
          purchaseError.underlyingErrorMessage.toLowerCase().includes('cancelled'));

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

    await notifyBackendOfPurchase(customerInfo, onSyncComplete);

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

export async function getCustomerInfo(): Promise<CustomerInfo> {
  try {
    // Ensure log handler is set before any SDK operations
    ensureLogHandler();
    const customerInfo = await Purchases.getCustomerInfo();
    return customerInfo;
  } catch (error) {
    console.error('❌ Error fetching customer info:', error);
    throw error;
  }
}

/**
 * Check if RevenueCat is actually initialized and ready to use
 * This is more reliable than just checking for API keys
 */
export async function isRevenueCatInitialized(): Promise<boolean> {
  try {
    await Purchases.getCustomerInfo();
    return true;
  } catch {
    return false;
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

export interface SyncResponse {
  status:
    | 'pending_webhook'
    | 'synced'
    | 'already_synced'
    | 'no_active_subscription'
    | 'unknown_product'
    | 'processing';
  message?: string;
  product_id?: string;
  tier?: string;
  credits_granted?: number;
}

async function notifyBackendOfPurchase(
  customerInfo: CustomerInfo,
  onSyncComplete?: (response: SyncResponse) => void | Promise<void>
): Promise<SyncResponse | null> {
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
      const errorText = await response.text();
      console.warn(`⚠️ Backend notification failed: ${response.status} - ${errorText}`);
      return null;
    }

    const result = (await response.json()) as SyncResponse;
    console.log('📊 Sync response:', JSON.stringify(result, null, 2));

    if (result.status === 'pending_webhook') {
      console.log('ℹ️ New subscription detected - processing via webhook');
      console.log('📡 Subscription will be activated within 30 seconds once validated');
      console.log(`📦 Product: ${result.product_id}, Tier: ${result.tier}`);
    } else if (result.status === 'synced') {
      console.log('✅ Subscription synced successfully');
      console.log(`📦 Tier: ${result.tier}, Product: ${result.product_id}`);
    } else if (result.status === 'already_synced') {
      console.log('✅ Subscription already synced');
      console.log(`📦 Tier: ${result.tier}, Product: ${result.product_id}`);
    } else if (result.status === 'no_active_subscription') {
      console.log('ℹ️ No active subscription found in customer info');
    } else {
      console.log('✅ Backend notified successfully');
    }

    // Call callback if provided (for cache invalidation, polling, etc.)
    if (onSyncComplete) {
      await onSyncComplete(result);
    }

    return result;
  } catch (error) {
    console.error('❌ Error notifying backend:', error);
    return null;
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

export async function presentPaywall(
  paywallName?: string
): Promise<{ purchased: boolean; cancelled: boolean }> {
  try {
    // Ensure log handler is set before any SDK operations
    ensureLogHandler();
    
    let offering: PurchasesOffering | null = null;

    // If paywall name is provided, try to get that specific offering
    if (paywallName) {
      console.log(`📱 Fetching paywall: ${paywallName}`);
      offering = await getOfferingById(paywallName, true);

      if (!offering) {
        // Log available offerings to help debug
        const allOfferings = await Purchases.getOfferings();
        const availableOfferingIds = Object.keys(allOfferings.all);
        console.error(`❌ Paywall '${paywallName}' not found in RevenueCat!`);
        console.log(`📦 Available offerings: ${availableOfferingIds.join(', ') || 'none'}`);
        console.log(`📦 Current offering: ${allOfferings.current?.identifier || 'none'}`);

        // Throw error instead of falling back - the paywall names must match RevenueCat
        throw new Error(`Paywall '${paywallName}' not found. Available: ${availableOfferingIds.join(', ')}`);
      }
    } else {
      // Default to current offering
      offering = await getOfferings(true);
    }

    if (!offering) {
      throw new Error('No offerings available to display');
    }

    console.log(`📱 Presenting RevenueCat paywall: ${offering.identifier}`);

    // Present the paywall using RevenueCatUI
    const result = await RevenueCatUI.presentPaywall({ offering });

    const purchased = result === RevenueCatUI.PAYWALL_RESULT.PURCHASED;
    const cancelled = result === RevenueCatUI.PAYWALL_RESULT.CANCELLED;

    if (purchased) {
      console.log('✅ User completed a purchase from paywall');
      // Get updated customer info after purchase
      const customerInfo = await Purchases.getCustomerInfo();
      await notifyBackendOfPurchase(customerInfo);
    } else if (cancelled) {
      console.log('🚫 User cancelled the paywall');
    } else {
      console.log('ℹ️ Paywall was dismissed without purchase');
    }

    return { purchased, cancelled };
  } catch (error) {
    console.error('❌ Error presenting paywall:', error);
    throw error;
  }
}

/**
 * Present RevenueCat Customer Info Portal
 *
 * Shows the native RevenueCat customer info screen where users can:
 * - View subscription details
 * - Manage payment methods
 * - View purchase history
 * - Restore purchases
 */
export async function presentCustomerInfo(): Promise<void> {
  try {
    console.log('📱 Presenting RevenueCat customer info portal...');
    await RevenueCatUI.presentCustomerCenter();
    console.log('✅ Customer info portal dismissed');
  } catch (error) {
    console.error('❌ Error presenting customer info portal:', error);
    throw error;
  }
}
