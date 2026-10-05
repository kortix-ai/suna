import type { ProviderName } from './index';

export interface ProviderComputeRateCard {
  cpuPerCoreSecond: number;
  memoryPerGbSecond: number;
  diskPerGbSecond: number;
}

// Per-second customer pricing for the reserved sandbox spec in kortix.yaml.
// Each rate is 1.2× Daytona's published list rate.
// Daytona list (https://www.daytona.io/pricing, as of 2026-06):
//   vCPU  $0.0504 / core-hour → 0.000014   per core-second
//   RAM   $0.0162 / GiB-hour  → 0.0000045  per GB-second
//   disk  $0.000108 / GiB-hour→ 0.00000003 per GB-second
// We bill the full reserved spec — Daytona's first-5-GiB-free RAM/disk allowance
// is an ORG-level promo to us, not a per-sandbox grant, so passing it per sandbox
// would under-bill.
const CUSTOMER_COMPUTE_RATE_CARD: ProviderComputeRateCard = {
  cpuPerCoreSecond: 0.0000168,
  memoryPerGbSecond: 0.0000054,
  diskPerGbSecond: 0.000000036,
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
