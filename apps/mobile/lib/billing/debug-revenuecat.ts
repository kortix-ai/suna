import { log } from '@/lib/logger';
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
  log.log('\n========== REVENUECAT DEBUG ==========');
  log.log('[RevenueCat] Platform:', Platform.OS);
  
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    log.log('\n[RevenueCat] 👤 CUSTOMER INFO:');
    log.log('  App User ID:', customerInfo.originalAppUserId);
    log.log('  Is Anonymous:', customerInfo.originalAppUserId.startsWith('$RCAnonymousID:'));
    log.log('  Active Subscriptions:', customerInfo.activeSubscriptions.length ? customerInfo.activeSubscriptions : 'NONE');
    log.log('  Active Entitlements:', Object.keys(customerInfo.entitlements.active).length 
      ? Object.keys(customerInfo.entitlements.active) 
      : 'NONE');
    log.log('  All Purchased Products:', customerInfo.allPurchasedProductIdentifiers.length 
      ? customerInfo.allPurchasedProductIdentifiers 
      : 'NONE');
    log.log('  Management URL:', customerInfo.managementURL || 'Not available');
    log.log('  Latest Expiration:', customerInfo.latestExpirationDate || 'None');
  } catch (error) {
    log.error('[RevenueCat] ❌ Failed to get customer info - SDK may not be initialized:', error);
    log.log('\n⚠️ Make sure the user is logged in before calling debugRevenueCat()');
    return;
  }

  try {
    const offerings = await Purchases.getOfferings();
    const offeringIds = Object.keys(offerings.all);
    log.log('\n[RevenueCat] 📦 OFFERINGS:');
    log.log('  Available:', offeringIds.length ? offeringIds : 'NONE');
    log.log('  Current:', offerings.current?.identifier || 'NONE');
    
    if (offeringIds.length === 0) {
      log.warn('\n  ⚠️ NO OFFERINGS AVAILABLE!');
      log.warn('  Check:');
      log.warn('  1. Products configured in App Store Connect / Google Play Console');
      log.warn('  2. Products added to RevenueCat Dashboard');
      log.warn('  3. Offerings created in RevenueCat Dashboard');
      log.warn('  4. API key matches your RevenueCat project');
    }

    for (const [id, offering] of Object.entries(offerings.all)) {
      const hasPaywall = (offering as any).paywall != null;
      log.log(`\n  📦 Offering: "${id}"`);
      log.log(`    Has Paywall Template: ${hasPaywall ? '✅ Yes' : '❌ No'}`);
      log.log(`    Packages: ${offering.availablePackages.length}`);
      offering.availablePackages.forEach(pkg => {
        log.log(`      - ${pkg.identifier}: ${pkg.product.identifier} (${pkg.product.priceString})`);
      });
    }
  } catch (error) {
    log.error('[RevenueCat] ❌ Failed to get offerings:', error);
  }

  // Test tier mappings
  log.log('\n[RevenueCat] 🧪 TIER MAPPINGS:');
  for (const tier of PRICING_TIERS) {
    if (tier.revenueCatId) {
      log.log(`\n  Testing ${tier.id} (${tier.revenueCatId}):`);
      try {
        const monthly = await findPackageForTier(tier.id, 'monthly');
        log.log(`    Monthly: ${monthly ? '✅ Found' : '❌ Not found'}`);
        
        const yearly = await findPackageForTier(tier.id, 'yearly_commitment');
        log.log(`    Yearly: ${yearly ? '✅ Found' : '❌ Not found'}`);
      } catch (error: any) {
        log.log(`    Error: ${error.message}`);
      }
    } else {
      log.log(`\n  ${tier.id}: ⚠️ No RevenueCat mapping (free tier)`);
    }
  }

  log.log('\n========================================\n');
}

/**
 * Quick check if RevenueCat is properly initialized
 */
export async function isRevenueCatWorking(): Promise<boolean> {
  try {
    await Purchases.getCustomerInfo();
    log.log('[RevenueCat] ✅ SDK is working');
    return true;
  } catch (error) {
    log.error('[RevenueCat] ❌ SDK not working:', error);
    return false;
  }
}

/**
 * Log all available products from RevenueCat
 */
export { logAvailableProducts };
