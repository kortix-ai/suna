export type Currency = 'USD' | 'EUR';

/**
 * Format a price amount with currency symbol
 * EUR: symbol after number (20€)
 * USD: symbol before number ($20)
 */
export function formatPrice(amount: number, currency: Currency): string {
  const symbol = getCurrencySymbol(currency);
  if (currency === 'EUR') {
    return `${amount}${symbol}`;
  }
  return `${symbol}${amount}`;
}

/**
 * Get currency symbol
 */
export function getCurrencySymbol(currency: Currency): string {
  return currency === 'EUR' ? '€' : '$';
}

/**
 * Convert price string from one currency to another
 * Example: "$20" with currency='EUR' → "20€"
 * Note: Assumes 1:1 parity
 */
export function convertPriceString(
  priceStr: string,
  toCurrency: Currency
): string {
  // Extract numeric value (works for "$20", "€20", "$20/mo", etc.)
  const amount = parseFloat(priceStr.replace(/[^\d.]/g, ''));
  
  if (isNaN(amount)) {
    return priceStr; // Return original if parsing fails
  }
  
  return formatPrice(amount, toCurrency);
}

/**
 * Parse numeric amount from price string
 * Example: "$20/mo" → 20
 */
export function parsePriceAmount(priceStr: string): number {
  return parseFloat(priceStr.replace(/[^\d.]/g, '') || '0');
}

/**
 * Convert all price strings in a tier to target currency
 */
export function convertTierPrices(
  tier: { price: string; yearlyPrice?: string },
  currency: Currency
): { price: string; yearlyPrice?: string } {
  return {
    price: convertPriceString(tier.price, currency),
    yearlyPrice: tier.yearlyPrice ? convertPriceString(tier.yearlyPrice, currency) : undefined,
  };
}

