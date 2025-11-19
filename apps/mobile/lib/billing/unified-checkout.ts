import { shouldUseRevenueCat } from './provider';
import { startPlanCheckout as startStripePlanCheckout, startCreditPurchase as startStripeCreditPurchase } from './checkout';
import { getOfferings, purchasePackage, presentPaywall } from './revenuecat';
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
      
      const offerings = await getOfferings();
      
      if (!offerings) {
        throw new Error('No offerings available');
      }

      const getPackageId = (tierKey: string, commitment: string) => {
        const baseMap: Record<string, string> = {
          'tier_2_20': 'plus',
          'tier_6_50': 'pro',
          'tier_25_200': 'ultra',
        };
        
        const baseName = baseMap[tierKey];
        if (!baseName) return null;
        
        if (commitment === 'yearly_commitment') {
          return `$rc_${baseName}_commitment`;
        }
        return `$rc_${baseName}_monthly`;
      };

      const packageIdentifier = getPackageId(tierKey, commitmentType);
      const pkg = packageIdentifier ? offerings.availablePackages.find(p => p.identifier === packageIdentifier) : null;

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
  onSuccess?: () => void,
  onCancel?: () => void
): Promise<void> {
  if (shouldUseRevenueCat()) {
    try {
      console.log('💰 Using RevenueCat for credit purchase...');
      
      const offerings = await getOfferings();
      
      if (!offerings) {
        throw new Error('No credit offerings available');
      }

      const creditPackageMap: Record<number, string> = {
        10: '$rc_credits_10',
        25: '$rc_credits_25',
        50: '$rc_credits_50',
        100: '$rc_credits_100',
        250: '$rc_credits_250',
        500: '$rc_credits_500',
      };

      const packageIdentifier = creditPackageMap[amount];
      const pkg = offerings.availablePackages.find(p => p.identifier === packageIdentifier);

      if (!pkg) {
        throw new Error(`Credit package not found for amount: ${amount}`);
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

