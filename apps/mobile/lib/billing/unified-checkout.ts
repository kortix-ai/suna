import { shouldUseRevenueCat } from './provider';
import { startPlanCheckout as startStripePlanCheckout, startCreditPurchase as startStripeCreditPurchase } from './checkout';
import { getOfferings, getOfferingById, purchasePackage, presentPaywall } from './revenuecat';
import { supabase } from '@/api/supabase';

export async function startUnifiedPlanCheckout(
  tierKey: string,
  commitmentType: 'monthly' | 'yearly' | 'yearly_commitment' = 'monthly',
  onSuccess?: () => void,
  onCancel?: () => void
): Promise<void> {
  if (shouldUseRevenueCat()) {
    try {
      console.log('💳 Using RevenueCat for plan checkout...');
      
      const offerings = await getOfferings(true);
      
      if (!offerings) {
        throw new Error('No offerings available');
      }

      // Map tier backend keys to RevenueCat product identifiers
      const tierToRevenueCatId: Record<string, string> = {
        'tier_2_20': 'kortix_plus',
        'tier_6_50': 'kortix_pro',
        'tier_12_100': 'kortix_business',
        'tier_25_200': 'kortix_ultra',
      };
      
      const revenueCatId = tierToRevenueCatId[tierKey];
      if (!revenueCatId) {
        throw new Error(`No RevenueCat mapping for tier: ${tierKey}`);
      }

      // Build product identifier: kortix_plus_monthly or kortix_plus_yearly
      const suffix = commitmentType === 'yearly_commitment' ? 'yearly' : 'monthly';
      const productIdentifier = `${revenueCatId}_${suffix}`;

      // Find package by product identifier
      const pkg = offerings.availablePackages.find(p => 
        p.product.identifier === productIdentifier
      );

      if (!pkg) {
        console.warn('⚠️ Package not found, showing paywall instead');
        await presentPaywall();
        onSuccess?.();
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      await purchasePackage(pkg, user?.email);
      onSuccess?.();
    } catch (error: any) {
      if (error.userCancelled) {
        onCancel?.();
      } else {
        throw error;
      }
    }
  } else {
    await startStripePlanCheckout(tierKey, commitmentType, onSuccess, onCancel);
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
  if (shouldUseRevenueCat()) {
    try {
      console.log('💰 Using RevenueCat for credit purchase...');
      
      let offerings = await getOfferingById('topups', true);
      
      if (!offerings) {
        console.warn('⚠️ No topups offering found, trying default offering');
        offerings = await getOfferings(true);
        if (!offerings) {
          throw new Error('No credit offerings available');
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
      await purchasePackage(pkg, user?.email);
      onSuccess?.();
    } catch (error: any) {
      if (error.userCancelled) {
        onCancel?.();
      } else {
        throw error;
      }
    }
  } else {
    await startStripeCreditPurchase(amount, onSuccess, onCancel);
  }
}

