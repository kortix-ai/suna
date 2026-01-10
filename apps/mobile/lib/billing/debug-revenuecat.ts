/**
 * RevenueCat Debug Utilities
 * 
 * Call these functions from the console or debug menu to inspect RevenueCat state
 */

import Purchases from 'react-native-purchases';
import { Platform } from 'react-native';
import { logAvailableProducts, findPackageForTier } from './revenuecat-utils';
import { PRICING_TIERS } from './pricing';

/**
 * Comprehensive debug function to dump all RevenueCat state
 * Call this from anywhere to troubleshoot issues:
 * 
 * import { debugRevenueCat } from '@/lib/billing';
 * debugRevenueCat();
 */
export async function debugRevenueCat(): Promise<void> {
  console.log('\n========== REVENUECAT DEBUG ==========');
  console.log('[RevenueCat] Platform:', Platform.OS);
  
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    console.log('\n[RevenueCat] 👤 CUSTOMER INFO:');
    console.log('  App User ID:', customerInfo.originalAppUserId);
    console.log('  Is Anonymous:', customerInfo.originalAppUserId.startsWith('$RCAnonymousID:'));
    console.log('  Active Subscriptions:', customerInfo.activeSubscriptions.length ? customerInfo.activeSubscriptions : 'NONE');
    console.log('  Active Entitlements:', Object.keys(customerInfo.entitlements.active).length 
      ? Object.keys(customerInfo.entitlements.active) 
      : 'NONE');
    console.log('  All Purchased Products:', customerInfo.allPurchasedProductIdentifiers.length 
      ? customerInfo.allPurchasedProductIdentifiers 
      : 'NONE');
    console.log('  Management URL:', customerInfo.managementURL || 'Not available');
    console.log('  Latest Expiration:', customerInfo.latestExpirationDate || 'None');
  } catch (error) {
    console.error('[RevenueCat] ❌ Failed to get customer info - SDK may not be initialized:', error);
    console.log('\n⚠️ Make sure the user is logged in before calling debugRevenueCat()');
    return;
  }

  try {
    const offerings = await Purchases.getOfferings();
    const offeringIds = Object.keys(offerings.all);
    console.log('\n[RevenueCat] 📦 OFFERINGS:');
    console.log('  Available:', offeringIds.length ? offeringIds : 'NONE');
    console.log('  Current:', offerings.current?.identifier || 'NONE');
    
    if (offeringIds.length === 0) {
      console.warn('\n  ⚠️ NO OFFERINGS AVAILABLE!');
      console.warn('  Check:');
      console.warn('  1. Products configured in App Store Connect / Google Play Console');
      console.warn('  2. Products added to RevenueCat Dashboard');
      console.warn('  3. Offerings created in RevenueCat Dashboard');
      console.warn('  4. API key matches your RevenueCat project');
    }

    for (const [id, offering] of Object.entries(offerings.all)) {
      const hasPaywall = (offering as any).paywall != null;
      console.log(`\n  📦 Offering: "${id}"`);
      console.log(`    Has Paywall Template: ${hasPaywall ? '✅ Yes' : '❌ No'}`);
      console.log(`    Packages: ${offering.availablePackages.length}`);
      offering.availablePackages.forEach(pkg => {
        console.log(`      - ${pkg.identifier}: ${pkg.product.identifier} (${pkg.product.priceString})`);
      });
    }
  } catch (error) {
    console.error('[RevenueCat] ❌ Failed to get offerings:', error);
  }

  // Test tier mappings
  console.log('\n[RevenueCat] 🧪 TIER MAPPINGS:');
  for (const tier of PRICING_TIERS) {
    if (tier.revenueCatId) {
      console.log(`\n  Testing ${tier.id} (${tier.revenueCatId}):`);
      try {
        const monthly = await findPackageForTier(tier.id, 'monthly');
        console.log(`    Monthly: ${monthly ? '✅ Found' : '❌ Not found'}`);
        
        const yearly = await findPackageForTier(tier.id, 'yearly_commitment');
        console.log(`    Yearly: ${yearly ? '✅ Found' : '❌ Not found'}`);
      } catch (error: any) {
        console.log(`    Error: ${error.message}`);
      }
    } else {
      console.log(`\n  ${tier.id}: ⚠️ No RevenueCat mapping (free tier)`);
    }
  }

  console.log('\n========================================\n');
}

/**
 * Quick check if RevenueCat is properly initialized
 */
export async function isRevenueCatWorking(): Promise<boolean> {
  try {
    await Purchases.getCustomerInfo();
    console.log('[RevenueCat] ✅ SDK is working');
    return true;
  } catch (error) {
    console.error('[RevenueCat] ❌ SDK not working:', error);
    return false;
  }
}

/**
 * Log all available products from RevenueCat
 */
export { logAvailableProducts };
