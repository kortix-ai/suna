'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getServerTypes, type ServerTypesResponse, type ServerType } from '@/lib/api/billing';
import { isBillingEnabled } from '@/lib/config';

// ─── Pricing ─────────────────────────────────────────────────────────────────
// The server-types API returns display prices (priceMonthlyMarkup) from the
// backend's COMPUTE_TIERS — the single source of truth for both the UI and
// Stripe.  We only filter to the tiers we expose; no client-side price
// overrides needed.
//
// FALLBACK_TYPES is used when the API is unreachable (e.g. guest on homepage).
// Keep these in sync with COMPUTE_TIERS in apps/api/src/billing/services/tiers.ts.

const ALLOWED_TIERS = new Set(['pro', 'power', 'ultra']);

/** Static fallback — used when the API is unreachable (e.g. guest on homepage). */
const fb = (name: string, cores: number, memory: number, disk: number, price: number): ServerType => ({
  name, description: '', cores, memory, disk, cpuType: 'shared', architecture: 'x86', priceMonthly: price, priceMonthlyMarkup: price, location: 'hel1',
});

const FALLBACK_TYPES: ServerType[] = [
  fb('pro',   8,  16, 320, 40),
  fb('power', 12, 24, 480, 60),
  fb('ultra', 16, 32, 640, 80),
];

const FALLBACK: ServerTypesResponse = {
  serverTypes: FALLBACK_TYPES,
  location: 'hel1',
  defaultServerType: 'pro',
  defaultLocation: 'hel1',
};

export function useServerTypes(location: string) {
  const query = useQuery<ServerTypesResponse>({
    queryKey: ['server-types', location],
    queryFn: () => getServerTypes(location),
    enabled: isBillingEnabled(),
    retry: 1,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  // Memoize so consumers get a referentially-stable serverTypes array.
  const data = useMemo<ServerTypesResponse>(() => {
    const raw = query.data && query.data.serverTypes.length > 0 ? query.data : null;
    if (!raw) return FALLBACK;
    return {
      ...raw,
      serverTypes: raw.serverTypes.filter((t) => ALLOWED_TIERS.has(t.name)),
      defaultServerType: 'pro',
      defaultLocation: 'hel1',
    };
  }, [query.data]);

  return {
    ...query,
    data,
    isLoading: query.isLoading && !query.isError,
  };
}
