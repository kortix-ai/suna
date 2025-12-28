/**
 * RevenueCat Pricing System
 * 
 * Standalone pricing system for mobile that loads prices from RevenueCat SDK
 * Completely separate from web pricing - uses App Store/Play Store prices
 */

import { getOfferings } from './revenuecat';
import { PRICING_TIERS, type PricingTier, type BillingPeriod } from './pricing';
import type { PurchasesPackage } from 'react-native-purchases';

export interface RevenueCatPricingData {
  tier: PricingTier;
  monthlyPackage: PurchasesPackage | null;
  yearlyPackage: PurchasesPackage | null;
  monthlyPrice: number;
  monthlyPriceString: string;
  yearlyPrice: number;
  yearlyPriceString: string;
  isAvailable: boolean;
}

/**
 * Get RevenueCat pricing for all tiers
 * Returns pricing data merged with tier metadata
 */
export async function getRevenueCatPricing(): Promise<Map<string, RevenueCatPricingData>> {
  const pricingMap = new Map<string, RevenueCatPricingData>();
  
  try {
    const offerings = await getOfferings(true);
    
    if (!offerings || !offerings.availablePackages.length) {
      console.warn('⚠️ No RevenueCat offerings available, using fallback pricing');
      // Return tiers with fallback pricing
      PRICING_TIERS.forEach(tier => {
        pricingMap.set(tier.id, {
          tier,
          monthlyPackage: null,
          yearlyPackage: null,
          monthlyPrice: tier.priceMonthly,
          monthlyPriceString: tier.price,
          yearlyPrice: tier.priceYearly || tier.priceMonthly,
          yearlyPriceString: tier.priceYearly ? `$${tier.priceYearly}` : tier.price,
          isAvailable: tier.id === 'free', // Free tier always available
        });
      });
      return pricingMap;
    }

    // Group packages by tier with improved matching
    const tierPackages = new Map<string, { monthly?: PurchasesPackage; yearly?: PurchasesPackage }>();

    console.log('🔍 Matching RevenueCat packages to tiers...');
    offerings.availablePackages.forEach((pkg) => {
      const productId = pkg.product.identifier.toLowerCase();
      const packageId = pkg.identifier.toLowerCase();
      
      // Find matching tier by revenueCatId (try multiple matching strategies)
      let matchingTier = PRICING_TIERS.find(tier => {
        if (!tier.revenueCatId) return false;
        const tierIdLower = tier.revenueCatId.toLowerCase();
        
        // Try exact match, then partial match
        return productId === `${tierIdLower}_monthly` ||
               productId === `${tierIdLower}_yearly` ||
               productId === `${tierIdLower} monthly` ||
               productId === `${tierIdLower} yearly` ||
               productId.includes(tierIdLower) ||
               packageId.includes(tierIdLower);
      });

      if (matchingTier) {
        const existing = tierPackages.get(matchingTier.id) || {};
        
        // Determine if monthly or yearly (check multiple patterns)
        const isYearly = productId.includes('yearly') || 
                        productId.includes('annual') || 
                        productId.includes('commitment') ||
                        packageId.includes('yearly') ||
                        packageId.includes('annual') ||
                        packageId.includes('commitment');
        
        if (isYearly) {
          existing.yearly = pkg;
          console.log(`  ✅ Matched ${matchingTier.id} yearly: ${pkg.identifier}`);
        } else {
          existing.monthly = pkg;
          console.log(`  ✅ Matched ${matchingTier.id} monthly: ${pkg.identifier}`);
        }
        
        tierPackages.set(matchingTier.id, existing);
      } else {
        console.log(`  ⚠️ No match for package: ${pkg.identifier} (Product: ${pkg.product.identifier})`);
      }
    });

    // Build pricing data for each tier
    PRICING_TIERS.forEach(tier => {
      const packages = tierPackages.get(tier.id);
      const monthlyPkg = packages?.monthly;
      // Exclude yearly package for Ultra (tier_25_200) - yearly not available
      const yearlyPkg = tier.id === 'tier_25_200' ? null : packages?.yearly;

      // Free tier is always available (no RevenueCat product)
      if (tier.id === 'free') {
        pricingMap.set(tier.id, {
          tier,
          monthlyPackage: null,
          yearlyPackage: null,
          monthlyPrice: 0,
          monthlyPriceString: '$0',
          yearlyPrice: 0,
          yearlyPriceString: '$0',
          isAvailable: true,
        });
        return;
      }

      // Paid tiers - use RevenueCat pricing if available
      const monthlyPrice = monthlyPkg?.product.price || tier.priceMonthly;
      const monthlyPriceString = monthlyPkg?.product.priceString || tier.price;
      // RevenueCat yearly products return the TOTAL yearly price (e.g., $204/year), not monthly equivalent
      // Ultra (tier_25_200) doesn't have yearly option
      const yearlyPrice = tier.id === 'tier_25_200' 
        ? 0 
        : (yearlyPkg?.product.price || (tier.priceYearly ? tier.priceYearly * 12 : tier.priceMonthly * 12));
      const yearlyPriceString = tier.id === 'tier_25_200'
        ? '$0'
        : (yearlyPkg?.product.priceString || (tier.priceYearly ? `$${tier.priceYearly * 12}` : `$${tier.priceMonthly * 12}`));

      pricingMap.set(tier.id, {
        tier,
        monthlyPackage: monthlyPkg || null,
        yearlyPackage: yearlyPkg || null,
        monthlyPrice,
        monthlyPriceString,
        yearlyPrice,
        yearlyPriceString,
        isAvailable: !!(monthlyPkg || yearlyPkg), // Available if at least one package exists
      });
    });

    console.log('✅ RevenueCat pricing loaded:', Array.from(pricingMap.entries()).map(([id, data]) => ({
      tier: id,
      monthly: data.monthlyPriceString,
      yearly: data.yearlyPriceString,
      available: data.isAvailable,
    })));

  } catch (error) {
    console.error('❌ Error loading RevenueCat pricing:', error);
    // Return fallback pricing
    PRICING_TIERS.forEach(tier => {
      pricingMap.set(tier.id, {
        tier,
        monthlyPackage: null,
        yearlyPackage: null,
        monthlyPrice: tier.priceMonthly,
        monthlyPriceString: tier.price,
        yearlyPrice: tier.priceYearly || tier.priceMonthly,
        yearlyPriceString: tier.priceYearly ? `$${tier.priceYearly}` : tier.price,
        isAvailable: tier.id === 'free',
      });
    });
  }

  return pricingMap;
}

/**
 * Get display price for a tier based on billing period
 * Uses RevenueCat pricing when available
 */
export function getRevenueCatDisplayPrice(
  pricingData: RevenueCatPricingData,
  period: BillingPeriod
): string {
  if (period === 'yearly_commitment' || period === 'yearly') {
    return pricingData.yearlyPriceString;
  }
  return pricingData.monthlyPriceString;
}

/**
 * Get the RevenueCat package for checkout
 */
export function getRevenueCatPackageForCheckout(
  pricingData: RevenueCatPricingData,
  period: BillingPeriod
): PurchasesPackage | null {
  if (period === 'yearly_commitment' || period === 'yearly') {
    return pricingData.yearlyPackage || pricingData.monthlyPackage;
  }
  return pricingData.monthlyPackage || pricingData.yearlyPackage;
}

/**
 * Calculate yearly savings using RevenueCat prices
 */
export function getRevenueCatYearlySavings(pricingData: RevenueCatPricingData): number {
  if (!pricingData.yearlyPackage || !pricingData.monthlyPackage) {
    // Fallback to hardcoded calculation
    return (pricingData.monthlyPrice - pricingData.yearlyPrice) * 12;
  }
  
  const monthlyTotal = pricingData.monthlyPrice * 12;
  const yearlyTotal = pricingData.yearlyPrice * 12;
  return monthlyTotal - yearlyTotal;
}












