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
import { log } from '@/lib/logger';

// Public API keys - these are safe to hardcode (designed to be in client apps)
const REVENUECAT_API_KEY_IOS = 'appl_UpcFYduOZYUgSqKPNvtzgXkPCeh';
const REVENUECAT_API_KEY_ANDROID = 'goog_wckzzdVDdOjbVHemqCsuFckMrMQ';

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
      // User cancellation is expected behavior, not an error - downgrade to info
      const isCancelledMessage = 
        message.toLowerCase().includes('cancelled') ||
        message.toLowerCase().includes('canceled') ||
        message.toLowerCase().includes('usercancelled');
      
      switch (logLevel) {
        case LOG_LEVEL.VERBOSE:
          log.rcDebug(message);
          break;
        case LOG_LEVEL.DEBUG:
          log.rcDebug(message);
          break;
        case LOG_LEVEL.INFO:
          log.rc(message);
          break;
        case LOG_LEVEL.WARN:
          // Downgrade cancellation warnings to debug level
          if (isCancelledMessage) {
            log.rcDebug(message);
          } else {
            log.rcWarn(message);
          }
          break;
        case LOG_LEVEL.ERROR:
          // Downgrade cancellation "errors" to info level - this is expected user behavior
          if (isCancelledMessage) {
            log.rc('User cancelled purchase (expected behavior)');
          } else {
            log.rcError(message);
          }
          break;
      }
    });
  } catch {
    // SDK might not be initialized yet, which is fine - handler will be set on configure
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
    ensureLogHandler();
    await Purchases.logOut();
    isConfigured = false;
    initializationPromise = null;
    customerInfoListenerAdded = false;
    lastSetEmail = null;
    lastSetUserId = null;
    currentInitializationParams = null;
  } catch (error) {
    log.rcError('Logout error:', error);
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
    log.rcError('Error setting attributes:', error);
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
        lastSetEmail = email;
      } catch (emailError) {
        log.rcWarn('Could not update email:', emailError);
      }
    }

    // Add listener if tracking is enabled and listener hasn't been added yet
    if (canTrack && !customerInfoListenerAdded) {
      Purchases.addCustomerInfoUpdateListener((customerInfo) => {
        notifyBackendOfPurchase(customerInfo);
      });
      customerInfoListenerAdded = true;
    }

    // Update user ID if it changed
    if (userId !== lastSetUserId) {
      try {
        const currentInfo = await Purchases.getCustomerInfo();
        const currentUserId = currentInfo.originalAppUserId;
        
        // Only call logIn if the user ID actually changed
        // RevenueCat SDK will warn if we call logIn with the same cached user ID
        if (currentUserId !== userId) {
          await Purchases.logIn(userId);
          lastSetUserId = userId;
        } else {
          // User ID matches, just update our cache
          lastSetUserId = userId;
        }
      } catch (error) {
        log.rcWarn('Could not update user ID:', error);
        // Still update our cache even if RevenueCat call failed
        lastSetUserId = userId;
      }
    }

    return;
  }

  // If initialization is in progress, wait for it to complete
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  const apiKey = Platform.OS === 'ios' ? REVENUECAT_API_KEY_IOS : REVENUECAT_API_KEY_ANDROID;

  if (!apiKey) {
    log.rcError('API key not configured for platform:', Platform.OS);
    throw new Error('RevenueCat API key not configured');
  }

  // Track current initialization parameters
  currentInitializationParams = { userId, email, canTrack };

  // Create a promise that will be shared by concurrent calls
  initializationPromise = (async () => {
    try {
      log.rc('Initializing for:', userId);

      // Ensure log handler is set before configure() to prevent "customLogHandler is not a function" errors
      ensureLogHandler();

      Purchases.configure({ apiKey, appUserID: userId });

      await new Promise((resolve) => setTimeout(resolve, 100));

      if (email && canTrack) {
        try {
          await Purchases.setEmail(email);
          lastSetEmail = email;
        } catch (emailError) {
          log.rcError('Error setting email:', emailError);
        }
      }

      if (canTrack && !customerInfoListenerAdded) {
        Purchases.addCustomerInfoUpdateListener((customerInfo) => {
          notifyBackendOfPurchase(customerInfo);
        });
        customerInfoListenerAdded = true;
      }

      isConfigured = true;
      lastSetUserId = userId;
      currentInitializationParams = null;
      log.rc('Initialized for user:', userId);
    } catch (error) {
      log.rcError('Initialization failed:', error);
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
    ensureLogHandler();
    
    if (forceRefresh) {
      try {
        const currentAppUserId = (await Purchases.getCustomerInfo()).originalAppUserId;
        await Purchases.invalidateCustomerInfoCache();
        await Purchases.syncPurchases();

        if (!currentAppUserId.startsWith('$RCAnonymousID:')) {
          await Purchases.logOut();
          ensureLogHandler();
          await Purchases.logIn(currentAppUserId);
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (resetError) {
        log.rcWarn('Cache reset failed:', resetError);
      }
    }

    const offerings = await Purchases.getOfferings();

    if (offerings.current) {
      return offerings.current;
    }

    log.rcWarn('No current offering available');
    return null;
  } catch (error) {
    log.rcError('Error fetching offerings:', error);
    throw error;
  }
}

export async function getOfferingById(
  offeringId: string,
  forceRefresh: boolean = false
): Promise<PurchasesOffering | null> {
  try {
    ensureLogHandler();
    
    if (forceRefresh) {
      try {
        const currentAppUserId = (await Purchases.getCustomerInfo()).originalAppUserId;
        await Purchases.invalidateCustomerInfoCache();
        await Purchases.syncPurchases();

        if (!currentAppUserId.startsWith('$RCAnonymousID:')) {
          await Purchases.logOut();
          ensureLogHandler();
          await Purchases.logIn(currentAppUserId);
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (resetError) {
        log.rcWarn('Cache reset failed:', resetError);
      }
    }

    const offerings = await Purchases.getOfferings();
    const availableOfferingIds = Object.keys(offerings.all);
    const offering = offerings.all[offeringId];

    if (offering) {
      return offering;
    }

    const errorMessage = `Offering '${offeringId}' not found. Available: ${availableOfferingIds.join(', ') || 'none'}`;
    log.rcError(errorMessage);
    
    const error: any = new Error(errorMessage);
    error.code = 'OFFERING_NOT_FOUND';
    error.availableOfferings = availableOfferingIds;
    throw error;
  } catch (error: any) {
    if (error?.code !== 'OFFERING_NOT_FOUND') {
      log.rcError('Error fetching offering:', offeringId, error);
    }
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
    ensureLogHandler();

    // Verify RevenueCat is linked to the correct user before purchase
    let currentCustomerInfo = await Purchases.getCustomerInfo();
    let rcUserId = currentCustomerInfo.originalAppUserId;

    const isAnonymous = rcUserId.startsWith('$RCAnonymousID:');
    const isMismatched = expectedUserId && rcUserId !== expectedUserId;

    if ((isAnonymous || isMismatched) && expectedUserId) {
      try {
        ensureLogHandler();
        // Check current user ID before logging in to avoid RevenueCat warning
        const currentInfo = await Purchases.getCustomerInfo();
        if (currentInfo.originalAppUserId !== expectedUserId) {
          const loginResult = await Purchases.logIn(expectedUserId);
          currentCustomerInfo = loginResult.customerInfo;
        } else {
          currentCustomerInfo = currentInfo;
        }
        rcUserId = currentCustomerInfo.originalAppUserId;

        // Check if this Apple ID already has an active subscription
        const hasActiveSubscription =
          Object.keys(currentCustomerInfo.entitlements.active).length > 0 ||
          currentCustomerInfo.activeSubscriptions.length > 0;

        if (hasActiveSubscription) {
          const error: any = new Error('You are already subscribed with a different account.');
          error.code = 'ALREADY_SUBSCRIBED_DIFFERENT_ACCOUNT';
          error.userCancelled = false;
          throw error;
        }
      } catch (loginError: any) {
        if (loginError.code === 'ALREADY_SUBSCRIBED_DIFFERENT_ACCOUNT') {
          throw loginError;
        }
        log.rcError('Session fix failed:', loginError);
        const error: any = new Error(
          'Unable to link your account. Please restart the app and try again.'
        );
        error.code = 'SESSION_FIX_FAILED';
        error.userCancelled = false;
        throw error;
      }
    }

    if (email) {
      try {
        await Purchases.setEmail(email);
      } catch (emailError) {
        log.rcWarn('Could not set email before purchase:', emailError);
      }
    }

    let customerInfo: CustomerInfo;
    try {
      const result = await Purchases.purchasePackage(pkg);
      customerInfo = result.customerInfo;
    } catch (purchaseError: any) {
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
        const cancelledError: any = Error('Purchase was cancelled by user');
        cancelledError.userCancelled = true;
        cancelledError.code = 'USER_CANCELLED';
        cancelledError.name = 'PurchaseCancelledError';
        throw cancelledError;
      }
      throw purchaseError;
    }

    log.rc('Purchase successful for user:', customerInfo.originalAppUserId);

    await notifyBackendOfPurchase(customerInfo, onSyncComplete);

    return customerInfo;
  } catch (error: any) {
    if (!error.userCancelled && error.code !== 'USER_CANCELLED') {
      log.rcError('Purchase error:', error);
    }
    throw error;
  }
}

export async function getCustomerInfo(): Promise<CustomerInfo> {
  try {
    ensureLogHandler();
    return await Purchases.getCustomerInfo();
  } catch (error) {
    log.rcError('Error fetching customer info:', error);
    throw error;
  }
}

/**
 * Check if RevenueCat is actually initialized and ready to use
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
      periodType: 'normal' as const,
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
      log.rcWarn('Backend sync failed:', response.status, errorText);
      return null;
    }

    const result = (await response.json()) as SyncResponse;
    log.rc('Sync result:', result.status, result.tier || '');

    if (onSyncComplete) {
      await onSyncComplete(result);
    }

    return result;
  } catch (error) {
    log.rcError('Error syncing with backend:', error);
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
    log.rcError('Error checking subscription status:', error);
    return { hasActiveSubscription: false };
  }
}

export async function presentPaywall(
  paywallName?: string
): Promise<{ purchased: boolean; cancelled: boolean }> {
  try {
    ensureLogHandler();
    
    let offering: PurchasesOffering | null = null;

    // Don't use forceRefresh - the logout/login cycle disrupts SDK state
    if (paywallName) {
      offering = await getOfferingById(paywallName, false);
      if (!offering) {
        const allOfferings = await Purchases.getOfferings();
        const error: any = new Error(`Offering '${paywallName}' not found`);
        error.code = 'OFFERING_NOT_FOUND';
        throw error;
      }
    } else {
      offering = await getOfferings(false);
    }

    if (!offering) {
      const error: any = new Error('No offerings available');
      error.code = 'NO_OFFERINGS';
      throw error;
    }
    
    log.rc('Presenting paywall:', offering.identifier);
    
    const result = await RevenueCatUI.presentPaywall({ 
      offering,
      displayCloseButton: true,
    });
    
    const { PAYWALL_RESULT } = RevenueCatUI;
    
    if (result === PAYWALL_RESULT.NOT_PRESENTED) {
      log.rcError('No paywall template for offering:', offering.identifier);
      const error: any = new Error(`No paywall template for '${offering.identifier}'`);
      error.code = 'NO_PAYWALL_TEMPLATE';
      throw error;
    }
    
    if (result === PAYWALL_RESULT.ERROR) {
      const error: any = new Error(`Error presenting paywall`);
      error.code = 'PAYWALL_PRESENTATION_ERROR';
      throw error;
    }
    
    const purchased = result === PAYWALL_RESULT.PURCHASED;
    const cancelled = result === PAYWALL_RESULT.CANCELLED;
    const restored = result === PAYWALL_RESULT.RESTORED;

    if (purchased || restored) {
      log.rc('Purchase completed, syncing...');
      const customerInfo = await Purchases.getCustomerInfo();
      await notifyBackendOfPurchase(customerInfo);
    }

    return { purchased: purchased || restored, cancelled };
  } catch (error: any) {
    log.rcError('Paywall error:', error?.message);
    throw error;
  }
}

/**
 * Present RevenueCat Customer Info Portal
 */
export async function presentCustomerInfo(): Promise<void> {
  try {
    await RevenueCatUI.presentCustomerCenter();
  } catch (error) {
    log.rcError('Error presenting customer info portal:', error);
    throw error;
  }
}

