'use client';

export interface ServerType {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  priceMonthly: number;
  priceMonthlyMarkup: number;
  location: string;
}

export interface ServerTypesResponse {
  serverTypes: ServerType[];
  location: string;
  defaultServerType?: string;
  defaultLocation?: string;
}

// Checkout products are provider-agnostic. Keep these display values aligned
// with COMPUTE_TIERS in apps/api/src/billing/services/tiers.ts.
const tier = (
  name: string,
  cores: number,
  memory: number,
  disk: number,
  price: number,
): ServerType => ({
  name,
  description: '',
  cores,
  memory,
  disk,
  cpuType: 'shared',
  architecture: 'x86',
  priceMonthly: price,
  priceMonthlyMarkup: price,
  location: 'hel1',
});

const SERVER_TYPES = [
  tier('pro', 8, 16, 320, 40),
  tier('power', 12, 24, 480, 60),
  tier('ultra', 16, 32, 640, 80),
];

export function useServerTypes(location: string): {
  data: ServerTypesResponse;
  isLoading: false;
  isError: false;
} {
  return {
    data: {
      serverTypes: SERVER_TYPES,
      location,
      defaultServerType: 'pro',
      defaultLocation: 'hel1',
    },
    isLoading: false,
    isError: false,
  };
}
