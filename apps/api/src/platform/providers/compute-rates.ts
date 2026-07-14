import type { ProviderName } from './index';

export interface ProviderComputeRateCard {
  cpuPerCoreSecond: number;
  memoryPerGbSecond: number;
  diskPerGbSecond: number;
  providerCostMultiplier: number;
}

const PROVIDER_COMPUTE_RATE_CARDS: Record<ProviderName, ProviderComputeRateCard> = {
  // Published list rates with Kortix's current Daytona volume discount.
  daytona: {
    cpuPerCoreSecond: 0.000014,
    memoryPerGbSecond: 0.0000045,
    diskPerGbSecond: 0.00000003,
    providerCostMultiplier: 0.5,
  },
  // Internal Platinum chargeback uses the same resource list basis, without a
  // third-party volume discount.
  platinum: {
    cpuPerCoreSecond: 0.000014,
    memoryPerGbSecond: 0.0000045,
    diskPerGbSecond: 0.00000003,
    providerCostMultiplier: 1,
  },
  // E2B Cloud Pro published compute rates. Persistent sandbox disk is included
  // in the sandbox compute price; snapshot storage is a separate provider cost.
  e2b: {
    cpuPerCoreSecond: 0.000014,
    memoryPerGbSecond: 0.0000045,
    diskPerGbSecond: 0,
    providerCostMultiplier: 1,
  },
};

export function getProviderComputeRateCard(name: ProviderName): ProviderComputeRateCard {
  return PROVIDER_COMPUTE_RATE_CARDS[name];
}
