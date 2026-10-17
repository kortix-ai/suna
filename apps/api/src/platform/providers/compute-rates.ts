import type { ProviderName } from './index';

export interface ProviderComputeRateCard {
  cpuPerCoreSecond: number;
  memoryPerGbSecond: number;
  diskPerGbSecond: number;
}

// Per-second customer pricing for the reserved sandbox spec in kortix.yaml:
// Platinum's list rates, at 1× (no markup), on every provider.
//   vCPU  $0.0324 / core-hour        → 0.000009          per core-second
//   RAM   $0.0108 / GB-hour          → 0.000003          per GB-second
//   disk  $0.0526 / GB-month (730 h) → 0.0526/730/3600   per GB-second
// The full reserved spec is billed; there is no free allowance.
const HOURS_PER_MONTH = 730;
const CUSTOMER_COMPUTE_RATE_CARD: ProviderComputeRateCard = {
  cpuPerCoreSecond: 0.0324 / 3600,
  memoryPerGbSecond: 0.0108 / 3600,
  diskPerGbSecond: 0.0526 / HOURS_PER_MONTH / 3600,
};

// Keep every provider explicit: adding a provider must also select its customer rate.
const PROVIDER_COMPUTE_RATE_CARDS: Record<ProviderName, ProviderComputeRateCard> = {
  daytona: CUSTOMER_COMPUTE_RATE_CARD,
  platinum: CUSTOMER_COMPUTE_RATE_CARD,
  e2b: CUSTOMER_COMPUTE_RATE_CARD,
};

export function getProviderComputeRateCard(name: ProviderName): ProviderComputeRateCard {
  return PROVIDER_COMPUTE_RATE_CARDS[name];
}
