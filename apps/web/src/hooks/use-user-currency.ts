'use client';

import { getCurrencySymbol, type Currency } from '@/lib/utils/currency';
import { detectCurrencyFromTimezone } from '@/lib/utils/region-currency';
import { useMemo } from 'react';

export interface UserCurrencyInfo {
  currency: Currency;
  symbol: string;
  isEU: boolean;
}

/**
 * Hook to detect user's currency based on timezone
 * Used for display purposes only - Stripe handles actual checkout currency
 */
export function useUserCurrency(): UserCurrencyInfo {
  const currencyInfo = useMemo(() => {
    const currency = detectCurrencyFromTimezone();

    return {
      currency,
      symbol: getCurrencySymbol(currency),
      isEU: currency === 'EUR',
    };
  }, []);

  return currencyInfo;
}
