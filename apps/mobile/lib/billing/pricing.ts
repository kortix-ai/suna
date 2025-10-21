/**
 * Pricing Configuration
 * 
 * Defines subscription tiers and their features
 */

export interface PricingTier {
  id: string;
  name: string;
  displayName: string;
  price: string;
  priceMonthly: number;
  priceYearly?: number;
  stripePriceId: string;
  stripeYearlyPriceId?: string;
  stripeYearlyCommitmentPriceId?: string;
  credits: number;
  features: string[];
  isPopular?: boolean;
  buttonText: string;
}

// Get Stripe price IDs based on environment
const ENV_MODE = process.env.EXPO_PUBLIC_ENV_MODE?.toLowerCase() || 'production';
const isProduction = ENV_MODE === 'production';

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'tier_2_20',
    name: 'Starter',
    displayName: 'Starter',
    price: '$20',
    priceMonthly: 20,
    priceYearly: 17, // 15% off
    stripePriceId: isProduction
      ? 'price_1RILb4G6l1KZGqIrhomjgDnO'
      : 'price_1RIGvuG6l1KZGqIrCRu0E4Gi',
    stripeYearlyPriceId: isProduction
      ? 'price_1ReHB5G6l1KZGqIrD70I1xqM'
      : 'price_1ReGogG6l1KZGqIrEyBTmtPk',
    stripeYearlyCommitmentPriceId: isProduction
      ? 'price_1RqtqiG6l1KZGqIrhjVPtE1s'
      : 'price_1RqYGaG6l1KZGqIrIzcdPzeQ',
    credits: 20,
    features: [
      '$20 AI token credits',
      'Custom agents',
      '100+ integrations',
      'Premium AI models',
      'Community support',
    ],
    isPopular: true,
    buttonText: 'Get Started',
  },
  {
    id: 'tier_6_50',
    name: 'Professional',
    displayName: 'Professional',
    price: '$50',
    priceMonthly: 50,
    priceYearly: 42.5, // 15% off
    stripePriceId: isProduction
      ? 'price_1RILb4G6l1KZGqIr5q0sybWn'
      : 'price_1RIGvuG6l1KZGqIrvjlz5p5V',
    stripeYearlyPriceId: isProduction
      ? 'price_1ReHAsG6l1KZGqIrlAog487C'
      : 'price_1ReGoJG6l1KZGqIr0DJWtoOc',
    stripeYearlyCommitmentPriceId: isProduction
      ? 'price_1Rqtr8G6l1KZGqIrQ0ql0qHi'
      : 'price_1RqYH1G6l1KZGqIrWDKh8xIU',
    credits: 50,
    features: [
      '$50 AI token credits',
      'Custom agents',
      '100+ integrations',
      'Premium AI models',
      'Priority support',
    ],
    buttonText: 'Upgrade',
  },
  {
    id: 'tier_12_100',
    name: 'Team',
    displayName: 'Team',
    price: '$100',
    priceMonthly: 100,
    priceYearly: 85, // 15% off
    stripePriceId: isProduction
      ? 'price_1RILb4G6l1KZGqIr5Y20ZLHm'
      : 'price_1RIGvuG6l1KZGqIrT6UfgblC',
    stripeYearlyPriceId: isProduction
      ? 'price_1ReHAWG6l1KZGqIrBHer2PQc'
      : 'price_1ReGnZG6l1KZGqIr0ThLEl5S',
    credits: 100,
    features: [
      '$100 AI token credits',
      'Custom agents',
      '100+ integrations',
      'Premium AI models',
      'Priority support',
    ],
    buttonText: 'Upgrade',
  },
  {
    id: 'tier_25_200',
    name: 'Business',
    displayName: 'Business',
    price: '$200',
    priceMonthly: 200,
    priceYearly: 170, // 15% off
    stripePriceId: isProduction
      ? 'price_1RILb4G6l1KZGqIrGAD8rNjb'
      : 'price_1RIGvuG6l1KZGqIrOVLKlOMj',
    stripeYearlyPriceId: isProduction
      ? 'price_1ReH9uG6l1KZGqIrsvMLHViC'
      : 'price_1ReGmzG6l1KZGqIre31mqoEJ',
    stripeYearlyCommitmentPriceId: isProduction
      ? 'price_1RqtrUG6l1KZGqIrEb8hLsk3'
      : 'price_1RqYHbG6l1KZGqIrAUVf8KpG',
    credits: 200,
    features: [
      '$200 AI token credits',
      'Custom agents',
      '100+ integrations',
      'Premium AI models',
      'Dedicated support',
    ],
    buttonText: 'Upgrade',
  },
];

export type BillingPeriod = 'monthly' | 'yearly_commitment';

/**
 * Get the appropriate price ID based on billing period
 */
export function getPriceId(
  tier: PricingTier,
  period: BillingPeriod
): string {
  if (period === 'yearly_commitment' && tier.stripeYearlyCommitmentPriceId) {
    return tier.stripeYearlyCommitmentPriceId;
  }
  return tier.stripePriceId;
}

/**
 * Get the display price based on billing period
 */
export function getDisplayPrice(
  tier: PricingTier,
  period: BillingPeriod
): string {
  if (period === 'yearly_commitment' && tier.priceYearly) {
    return `$${tier.priceYearly}`;
  }
  return tier.price;
}

/**
 * Calculate savings for yearly commitment
 */
export function getYearlySavings(tier: PricingTier): number {
  if (!tier.priceYearly) return 0;
  return (tier.priceMonthly - tier.priceYearly) * 12;
}

