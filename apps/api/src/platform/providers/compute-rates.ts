import type { ProviderName } from './index';

export interface ProviderComputeRateCard {
  cpuPerCoreSecond: number;
  memoryPerGbSecond: number;
  diskPerGbSecond: number;
}

const PROVIDER_COMPUTE_RATE_CARDS: Record<ProviderName, ProviderComputeRateCard> = {
  // Hosted providers use one customer price at 1.2× Daytona's list rates.
  daytona: {
    cpuPerCoreSecond: 0.0000168,
    memoryPerGbSecond: 0.0000054,
    diskPerGbSecond: 0.000000036,
  },
  platinum: {
    cpuPerCoreSecond: 0.0000168,
    memoryPerGbSecond: 0.0000054,
    diskPerGbSecond: 0.000000036,
  },
  e2b: {
    cpuPerCoreSecond: 0.0000168,
    memoryPerGbSecond: 0.0000054,
    diskPerGbSecond: 0.000000036,
  },
  // local-docker uses operator hardware. Meter usage without debiting credits.
  'local-docker': {
    cpuPerCoreSecond: 0,
    memoryPerGbSecond: 0,
    diskPerGbSecond: 0,
  },
};

export function getProviderComputeRateCard(name: ProviderName): ProviderComputeRateCard {
  return PROVIDER_COMPUTE_RATE_CARDS[name];
}
