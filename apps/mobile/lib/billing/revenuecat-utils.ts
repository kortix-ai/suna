/**
 * RevenueCat Utilities
 * 
 * Helper functions for debugging and mapping RevenueCat products
 */

import { getOfferings } from './revenuecat';
import { PRICING_TIERS } from './pricing';
import { log } from '@/lib/logger';

/**
 * Log all available RevenueCat products for debugging
 */
export async function logAvailableProducts(): Promise<void> {
  try {
    const offerings = await getOfferings(true);
    if (!offerings) {
      log.log('⚠️ No offerings available');
      return;
    }

    log.log('📦 RevenueCat Offerings Debug:');
    log.log('  Offering ID:', offerings.identifier);
    log.log('  Available Packages:');
    
    offerings.availablePackages.forEach((pkg) => {
      log.log(`    - ${pkg.identifier}`);
      log.log(`      Product ID: ${pkg.product.identifier}`);
      log.log(`      Price: ${pkg.product.priceString}`);
      log.log(`      Package Type: ${pkg.packageType}`);
    });

    log.log('\n📋 Expected Tier Mappings:');
    PRICING_TIERS.forEach((tier) => {
      if (tier.revenueCatId) {
        log.log(`  ${tier.id} -> ${tier.revenueCatId}_monthly / ${tier.revenueCatId}_yearly`);
      } else {
        log.log(`  ${tier.id} -> (no RevenueCat mapping - free tier)`);
      }
    });
  } catch (error) {
    log.error('❌ Error logging products:', error);
  }
}

/**
 * Find RevenueCat package by tier key and billing period
 * Uses the RevenueCat pricing system for reliable matching
 * Returns null if not found (e.g., for free tier)
 */
export async function findPackageForTier(
  tierKey: string,
  commitmentType: 'monthly' | 'yearly' | 'yearly_commitment'
): Promise<{ package: any; productId: string } | null> {
  // Free tier doesn't have RevenueCat products
  if (tierKey === 'free') {
    return null;
  }

  // Use the RevenueCat pricing system for reliable package finding
  const { getRevenueCatPricing, getRevenueCatPackageForCheckout } = await import('./revenuecat-pricing');
  const pricingMap = await getRevenueCatPricing();
  const pricingData = pricingMap.get(tierKey);

  if (!pricingData) {
    log.warn(`⚠️ No pricing data found for tier: ${tierKey}`);
    return null;
  }

  // Get the appropriate package for checkout
  const pkg = getRevenueCatPackageForCheckout(pricingData, commitmentType);

  if (pkg) {
    log.log(`✅ Found package via pricing system: ${pkg.identifier} (Product: ${pkg.product.identifier})`);
    return { package: pkg, productId: pkg.product.identifier };
  }

  log.warn(`⚠️ Package not available for tier ${tierKey} with period ${commitmentType}`);
  return null;
}












