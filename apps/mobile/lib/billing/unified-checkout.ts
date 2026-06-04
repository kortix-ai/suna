import { log } from '@/lib/logger';
import { shouldUseRevenueCat } from './provider';
import { purchasePackage, presentPaywall, getOfferings, getOfferingById, type SyncResponse } from './revenuecat';
import { findPackageForTier, logAvailableProducts } from './revenuecat-utils';
import { supabase } from '@/api/supabase';
import { PRICING_TIERS } from './pricing';

/**
 * Start unified plan checkout
 * ONLY supports RevenueCat (native) checkout - web checkout is disabled
 */
export async function startUnifiedPlanCheckout(
  tierKey: string,
  commitmentType: 'monthly' | 'yearly' | 'yearly_commitment' = 'monthly',
  onSuccess?: () => void,
  onCancel?: () => void,
  onSyncComplete?: (response: SyncResponse) => void | Promise<void>
): Promise<void> {
  log.log(`💳 Starting checkout for tier: ${tierKey}, period: ${commitmentType}`);

  // Check if RevenueCat is available
  if (!shouldUseRevenueCat()) {
    const error = new Error('Native checkout is not available on this platform. Please use the web app for subscription management.');
    log.error('❌ RevenueCat not available:', error.message);
    onCancel?.();
    throw error;
  }

  // Free tier - not supported via RevenueCat
  if (tierKey === 'free') {
    const error = new Error('Free tier cannot be purchased. Please select a paid plan.');
    log.error('❌ Free tier checkout:', error.message);
    onCancel?.();
    throw error;
  }

  // Verify tier exists
  const tier = PRICING_TIERS.find(t => t.id === tierKey);
  if (!tier) {
    throw new Error(`Invalid tier key: ${tierKey}`);
  }

  // Only proceed with RevenueCat native checkout
  try {
    log.log('💳 Using RevenueCat for plan checkout...');
    
    // Ensure RevenueCat is initialized before fetching offerings
    const { initializeRevenueCat } = await import('./revenuecat');
    const { data: { user } } = await supabase.auth.getUser();
    
    if (user) {
      try {
        await initializeRevenueCat(user.id, user.email, true);
      } catch (initError) {
        log.warn('⚠️ RevenueCat initialization warning (may already be initialized):', initError);
      }
    }

    // Find the package for this tier using improved matching
    const packageResult = await findPackageForTier(tierKey, commitmentType);
    
    if (!packageResult) {
      // If package not found, log available products for debugging
      log.warn('⚠️ RevenueCat package not found for tier:', tierKey);
      await logAvailableProducts();
      
      // Try showing paywall as fallback
      log.log('🔄 Attempting to show paywall as fallback...');
      try {
        await presentPaywall();
        onSuccess?.();
        return;
      } catch (paywallError) {
        log.error('❌ Paywall failed:', paywallError);
        const error = new Error(`Plan not available. Please check App Store/Play Store for available plans.`);
        onCancel?.();
        throw error;
      }
    }

    const { package: pkg } = packageResult;
    log.log(`✅ Found RevenueCat package: ${pkg.identifier} (Product: ${pkg.product.identifier})`);
    log.log(`💰 Price: ${pkg.product.priceString}`);
    
    await purchasePackage(pkg, user?.email, user?.id, onSyncComplete);
    onSuccess?.();
  } catch (error: any) {
    log.error('❌ RevenueCat checkout error:', error);
    
    if (error.userCancelled) {
      log.log('ℹ️ User cancelled purchase');
      onCancel?.();
      return;
    }
    
    // No fallback to web checkout - throw error
    throw error;
  }
}

export async function startUnifiedCreditPurchase(
  amount: number,
  packageIdOrCallback?: string | (() => void),
  onSuccessOrCancel?: (() => void) | (() => void),
  onCancelParam?: () => void
): Promise<void> {
  let packageId: string | undefined;
  let onSuccess: (() => void) | undefined;
  let onCancel: (() => void) | undefined;

  if (typeof packageIdOrCallback === 'string') {
    packageId = packageIdOrCallback;
    onSuccess = onSuccessOrCancel as (() => void) | undefined;
    onCancel = onCancelParam;
  } else {
    onSuccess = packageIdOrCallback;
    onCancel = onSuccessOrCancel as (() => void) | undefined;
  }

  // Check if RevenueCat is available
  if (!shouldUseRevenueCat()) {
    const error = new Error('Native checkout is not available on this platform. Please use the web app for credit purchases.');
    log.error('❌ RevenueCat not available:', error.message);
    onCancel?.();
    throw error;
  }

  // Only proceed with RevenueCat native checkout
  try {
    log.log('💰 Using RevenueCat for credit purchase...');
    
    let offerings = await getOfferingById('topups', true);
    
    if (!offerings) {
      log.warn('⚠️ No topups offering found, trying default offering');
      try {
        offerings = await getOfferings(true);
        if (!offerings) {
          throw new Error('No credit offerings available. Please check your RevenueCat dashboard configuration.');
        }
      } catch (getOfferingsError: any) {
        // If getOfferings also fails, provide helpful error message
        if (getOfferingsError?.code === 'CONFIGURATION_ERROR') {
          throw new Error(
            'RevenueCat configuration error: The "topups" offering is not properly configured. ' +
            'Please ensure the offering exists in your RevenueCat dashboard and has packages configured.'
          );
        }
        throw getOfferingsError;
      }
    }

    let packageIdentifier = packageId;
    
    if (!packageIdentifier) {
      const creditPackageMap: Record<number, string> = {
        10: 'kortix_topup_starter',
        25: 'kortix_topup_plus',
        50: 'kortix_topup_popular',
        100: 'kortix_topup_pro',
        250: 'kortix_topup_business',
        500: 'kortix_topup_enterprise',
      };
      packageIdentifier = creditPackageMap[amount];
    }

    const pkg = offerings.availablePackages.find(p => p.identifier === packageIdentifier);

    if (!pkg) {
      throw new Error(`Credit package not found for amount: ${amount}. Available packages: ${offerings.availablePackages.map(p => p.identifier).join(', ')}`);
    }

    const { data: { user } } = await supabase.auth.getUser();
    await purchasePackage(pkg, user?.email, user?.id);
    onSuccess?.();
  } catch (error: any) {
    if (error.userCancelled) {
      onCancel?.();
    } else {
      // Log configuration errors with more context
      if (error?.code === 'CONFIGURATION_ERROR' || error?.code === 'OFFERING_NOT_FOUND') {
        log.error('❌ RevenueCat configuration issue for credit purchase:', {
          error: error.message,
          availableOfferings: error?.availableOfferings,
          amount,
        });
      }
      throw error;
    }
  }
}

