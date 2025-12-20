/**
 * RevenueCat Debug Utilities
 * 
 * Call these functions from the console or debug menu to inspect RevenueCat state
 */

import { logAvailableProducts, findPackageForTier } from './revenuecat-utils';
import { PRICING_TIERS } from './pricing';

/**
 * Debug function to check all RevenueCat products
 * Call this from console: import { debugRevenueCat } from '@/lib/billing/debug-revenuecat'; debugRevenueCat();
 */
export async function debugRevenueCat(): Promise<void> {
  console.log('🔍 RevenueCat Debug Session');
  console.log('========================');
  
  await logAvailableProducts();
  
  console.log('\n🧪 Testing Tier Mappings:');
  for (const tier of PRICING_TIERS) {
    if (tier.revenueCatId) {
      console.log(`\nTesting ${tier.id} (${tier.revenueCatId}):`);
      try {
        const monthly = await findPackageForTier(tier.id, 'monthly');
        console.log(`  Monthly: ${monthly ? '✅ Found' : '❌ Not found'}`);
        
        const yearly = await findPackageForTier(tier.id, 'yearly_commitment');
        console.log(`  Yearly: ${yearly ? '✅ Found' : '❌ Not found'}`);
      } catch (error: any) {
        console.log(`  Error: ${error.message}`);
      }
    } else {
      console.log(`\n${tier.id}: ⚠️ No RevenueCat mapping (free tier)`);
    }
  }
}












