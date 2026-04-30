import type { TierConfig, DailyCreditConfig } from '../../types';
import { config } from '../../config';

export const TOKEN_PRICE_MULTIPLIER = 1.2;
export const MINIMUM_CREDIT_FOR_RUN = 0.01;
export const DEFAULT_TOKEN_COST = 0.000002;
export const CREDITS_PER_DOLLAR = 100;

/** One-time credit grant per machine provisioned ($5 = 500 display credits). */
export const MACHINE_CREDIT_BONUS = 5;

/** Markup applied to managed VPS prices for additional instances. */
export const COMPUTE_PRICE_MARKUP = 1.2;

// ─── Compute instance definitions ───────────────────────────────────────────
// Single source of truth for the machine tiers we sell.  Prices and specs must
// stay in sync with the frontend's DISPLAY_PRICES / FALLBACK_TYPES in
// apps/web/src/hooks/instance/use-server-types.ts.

interface ComputeTier {
  label: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  priceUsd: number;
}

export const COMPUTE_TIERS: Record<string, ComputeTier> = {
  pro:   { label: 'Pro',   cores: 8,  memoryGb: 16, diskGb: 320, priceUsd: 40 },
  power: { label: 'Power', cores: 12, memoryGb: 24, diskGb: 480, priceUsd: 60 },
  ultra: { label: 'Ultra', cores: 16, memoryGb: 32, diskGb: 640, priceUsd: 80 },
};

/** Return the display price in USD cents for a server type, or null if unknown. */
export function getComputeDisplayPriceCents(serverType: string): number | null {
  const tier = COMPUTE_TIERS[serverType];
  return tier ? tier.priceUsd * 100 : null;
}

/**
 * Human-readable line for Stripe checkout / invoice descriptions.
 * Example: "Kortix Computer · Pro — 8 vCPU, 16 GB RAM, 320 GB SSD"
 */
export function getComputeDescription(serverType: string): string {
  const t = COMPUTE_TIERS[serverType];
  if (!t) return 'Kortix Computer';
  return `Kortix Computer · ${t.label} — ${t.cores} vCPU, ${t.memoryGb} GB RAM, ${t.diskGb} GB SSD`;
}

// ─── Tiers ──────────────────────────────────────────────────────────────────

const TIERS: Record<string, TierConfig> = {
  none: {
    name: 'none',
    displayName: 'No Plan',
    monthlyPrice: 0,
    yearlyPrice: 0,
    monthlyCredits: 0,
    canPurchaseCredits: false,
    models: [],
    dailyCreditConfig: null,
    hidden: true,
  },

  free: {
    name: 'free',
    displayName: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    monthlyCredits: 0,
    canPurchaseCredits: false,
    models: ['haiku'],
    dailyCreditConfig: null,   // No daily credits — BYOC only
    hidden: false,
  },

  // ── Starter tier — managed sandbox + daily credits, no CC required ────────
  // Replaces the signup friction of BYOC. User gets a managed sandbox and
  // enough daily credits for 2-3 Sonnet agent runs/day. Upgrades to Pro for
  // unlimited runs + compute add-ons. Introduced Apr 2026.
  starter: {
    name: 'starter',
    displayName: 'Starter',
    monthlyPrice: 0,
    yearlyPrice: 0,
    monthlyCredits: 0,
    canPurchaseCredits: false,
    models: ['haiku', 'sonnet'],   // Sonnet access but daily-capped
    dailyCreditConfig: {
      dailyAmount: 5,              // $5 credits/day = ~2-3 claude-sonnet-4-6 runs
      refreshIntervalHours: 24,
      maxAccumulation: 10,         // Max 2-day rollover — prevents stockpiling
    },
    hidden: false,
  },

  pro: {
    name: 'pro',
    displayName: 'Pro',
    monthlyPrice: 20,
    yearlyPrice: 0,            // No yearly billing
    monthlyCredits: 0,         // No monthly credits — $5 one-time per machine only
    canPurchaseCredits: true,
    models: ['all'],
    dailyCreditConfig: null,
    hidden: false,
  },

  // ── Legacy tiers (kept for backward compat with existing DB rows) ────────
  // All hidden, resolve to their closest equivalent for display.
  // Legacy tiers: monthlyCredits = monthlyPrice (1:1 ratio, i.e. $20 plan → $20 credits → 2000 display credits)
  tier_2_20:      { name: 'tier_2_20',      displayName: 'Plus (Legacy)',       monthlyPrice: 20,   yearlyPrice: 204,   monthlyCredits: 20,   canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
  tier_6_50:      { name: 'tier_6_50',      displayName: 'Pro (Legacy)',        monthlyPrice: 50,   yearlyPrice: 510,   monthlyCredits: 50,   canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
  tier_12_100:    { name: 'tier_12_100',    displayName: 'Business (Legacy)',   monthlyPrice: 100,  yearlyPrice: 1020,  monthlyCredits: 100,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
  tier_25_200:    { name: 'tier_25_200',    displayName: 'Ultra (Legacy)',      monthlyPrice: 200,  yearlyPrice: 2040,  monthlyCredits: 200,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
  tier_50_400:    { name: 'tier_50_400',    displayName: 'Enterprise (Legacy)', monthlyPrice: 400,  yearlyPrice: 4080,  monthlyCredits: 400,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
  tier_125_800:   { name: 'tier_125_800',   displayName: 'Scale (Legacy)',      monthlyPrice: 800,  yearlyPrice: 8160,  monthlyCredits: 800,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
  tier_200_1000:  { name: 'tier_200_1000',  displayName: 'Max (Legacy)',        monthlyPrice: 1000, yearlyPrice: 10200, monthlyCredits: 1000, canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
  tier_150_1200:  { name: 'tier_150_1200',  displayName: 'Enterprise Max (Legacy)', monthlyPrice: 1200, yearlyPrice: 12240, monthlyCredits: 1200, canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true },
};

// ─── Stripe Price IDs ────────────────────────────────────────────────────────

interface TierPriceIds {
  monthly?: string;
  yearly?: string;
  yearlyCommitment?: string;
}

interface StripePriceConfig {
  subscriptions: Record<string, TierPriceIds>;
  credits: Record<number, string>;
  productId: string;
  computeProductId: string;
}

const STRIPE_PRICES_PROD: StripePriceConfig = {
  subscriptions: {
    free:    { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    // starter: shares the $0 free Stripe price — no CC, no checkout friction.
    // TODO: create a dedicated starter price_id in prod Stripe and replace this.
    starter: { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    pro:     { monthly: 'price_1RILb4G6l1KZGqIrhomjgDnO' }, // TODO: create prod Pro price and replace
    // Legacy price → tier mappings (for webhook resolution of existing subs)
    tier_2_20:     { monthly: 'price_1RILb4G6l1KZGqIrhomjgDnO', yearly: 'price_1ReHB5G6l1KZGqIrD70I1xqM', yearlyCommitment: 'price_1RqtqiG6l1KZGqIrhjVPtE1s' },
    tier_6_50:     { monthly: 'price_1RILb4G6l1KZGqIr5q0sybWn', yearly: 'price_1ReHAsG6l1KZGqIrlAog487C', yearlyCommitment: 'price_1Rqtr8G6l1KZGqIrQ0ql0qHi' },
    tier_12_100:   { monthly: 'price_1RILb4G6l1KZGqIr5Y20ZLHm', yearly: 'price_1ReHAWG6l1KZGqIrBHer2PQc' },
    tier_25_200:   { monthly: 'price_1RILb4G6l1KZGqIrGAD8rNjb', yearly: 'price_1ReH9uG6l1KZGqIrsvMLHViC', yearlyCommitment: 'price_1RqtrUG6l1KZGqIrEb8hLsk3' },
    tier_50_400:   { monthly: 'price_1RILb4G6l1KZGqIruNBUMTF1', yearly: 'price_1ReH9fG6l1KZGqIrsPtu5KIA' },
    tier_125_800:  { monthly: 'price_1RILb3G6l1KZGqIrbJA766tN', yearly: 'price_1ReH9GG6l1KZGqIrfgqaJyat' },
    tier_200_1000: { monthly: 'price_1RILb3G6l1KZGqIrmauYPOiN', yearly: 'price_1ReH8qG6l1KZGqIrK1akY90q' },
  },
  credits: {
    10:  'price_1RxmQUG6l1KZGqIru453O1zW',
    25:  'price_1RxmQlG6l1KZGqIr3hS5WtGg',
    50:  'price_1RxmQvG6l1KZGqIrLbMZ3D6r',
    100: 'price_1RxmR3G6l1KZGqIrpLwFCGac',
    250: 'price_1RxmRAG6l1KZGqIrtBIMsZAj',
    500: 'price_1RxmRGG6l1KZGqIrSyvl6w1G',
  },
  productId: 'prod_SCl7AQ2C8kK1CD',
  computeProductId: 'prod_SCl7AQ2C8kK1CD', // TODO: create prod compute product
};

const STRIPE_PRICES_STAGING: StripePriceConfig = {
  subscriptions: {
    free:    { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    starter: { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' }, // same $0 price as free for staging
    pro:     { monthly: 'price_1T7yiuG6CaZppiKc7VsgnlKI' },
  },
  credits: {
    10:  'price_1T56YGG6CaZppiKcSwnwZSoE',
    25:  'price_1T56YHG6CaZppiKcFhLsjEHI',
    50:  'price_1T56YIG6CaZppiKc6fdKANgh',
    100: 'price_1T56YIG6CaZppiKcBsRi2UH0',
    250: 'price_1T56YKG6CaZppiKcGeILSj6N',
    500: 'price_1T56YKG6CaZppiKcHDTLQLIM',
  },
  productId: 'prod_U3CxqRenahYVvj',
  computeProductId: 'prod_U6B5Gh1aMPdnLO',
};

function getStripePrices(): StripePriceConfig {
  return config.INTERNAL_KORTIX_ENV === 'prod' ? STRIPE_PRICES_PROD : STRIPE_PRICES_STAGING;
}

export function getProductId(): string {
  return getStripePrices().productId;
}

export function getComputeProductId(): string {
  return getStripePrices().computeProductId;
}

export function resolvePriceId(tierKey: string, billingPeriod?: string): string | null {
  const prices = getStripePrices();
  const tierPrices = prices.subscriptions[tierKey];
  if (!tierPrices) return null;

  if (billingPeriod === 'yearly_commitment') return tierPrices.yearlyCommitment ?? null;
  if (billingPeriod === 'yearly') return tierPrices.yearly ?? null;
  return tierPrices.monthly ?? null;
}

export function resolveCreditPriceId(amountDollars: number): string | null {
  const prices = getStripePrices();
  return prices.credits[amountDollars] ?? null;
}

export function getCreditPackageAmounts(): number[] {
  return Object.keys(getStripePrices().credits).map(Number).sort((a, b) => a - b);
}

// ─── Price ID ↔ Tier reverse lookup ─────────────────────────────────────────

const priceIdToTier = new Map<string, string>();

function registerPriceId(priceId: string, tierName: string) {
  priceIdToTier.set(priceId, tierName);
}

function initPriceIdMap() {
  for (const priceConfig of [STRIPE_PRICES_PROD, STRIPE_PRICES_STAGING]) {
    for (const [tierName, tierPrices] of Object.entries(priceConfig.subscriptions)) {
      if (tierPrices.monthly) registerPriceId(tierPrices.monthly, tierName);
      if (tierPrices.yearly) registerPriceId(tierPrices.yearly, tierName);
      if (tierPrices.yearlyCommitment) registerPriceId(tierPrices.yearlyCommitment, tierName);
    }
  }
}
initPriceIdMap();

// ─── Tier helpers ────────────────────────────────────────────────────────────

export function getTier(name: string): TierConfig {
  return TIERS[name] ?? TIERS.none;
}

export function getTierByPriceId(priceId: string): TierConfig | null {
  const name = priceIdToTier.get(priceId);
  return name ? TIERS[name] ?? null : null;
}

export function getBillingPeriodByPriceId(priceId: string): 'monthly' | 'yearly' | 'yearly_commitment' | null {
  for (const priceConfig of [STRIPE_PRICES_PROD, STRIPE_PRICES_STAGING]) {
    for (const tierPrices of Object.values(priceConfig.subscriptions)) {
      if (tierPrices.monthly === priceId) return 'monthly';
      if (tierPrices.yearly === priceId) return 'yearly';
      if (tierPrices.yearlyCommitment === priceId) return 'yearly_commitment';
    }
  }

  return null;
}

export function getAllTiers(): TierConfig[] {
  return Object.values(TIERS);
}

export function getVisibleTiers(): TierConfig[] {
  return Object.values(TIERS).filter((t) => !t.hidden && t.name !== 'none');
}

export function isValidTier(name: string): boolean {
  return name in TIERS;
}

export function getMonthlyCredits(tierName: string): number {
  return getTier(tierName).monthlyCredits;
}

export function canPurchaseCredits(tierName: string): boolean {
  return getTier(tierName).canPurchaseCredits;
}

/** Returns true if the tier gets a managed sandbox provisioned (not BYOC-only free/none). */
export function isPaidTier(tierName: string): boolean {
  // 'starter' is $0 but gets a managed sandbox — treat as "paid" for provisioning purposes.
  return tierName !== 'free' && tierName !== 'none';
}

/** Legacy paid tiers eligible for the "claim computer" flow. */
export const LEGACY_PAID_TIERS = ['tier_2_20', 'tier_6_50', 'tier_12_100', 'tier_25_200', 'tier_50_400', 'tier_125_800', 'tier_200_1000', 'tier_150_1200'] as const;

export function isLegacyPaidTier(tierName: string): boolean {
  return (LEGACY_PAID_TIERS as readonly string[]).includes(tierName);
}

export function getDailyCreditConfig(tierName: string): DailyCreditConfig | null {
  return getTier(tierName).dailyCreditConfig;
}

export function getTierOrder(tierName: string): number {
  const order = [
    'none',
    'free',
    'starter',   // $0 managed sandbox tier — between free (BYOC) and pro
    'pro',
    // Legacy tiers ordered above pro for backward compat
    'tier_2_20',
    'tier_6_50',
    'tier_12_100',
    'tier_25_200',
    'tier_50_400',
    'tier_125_800',
    'tier_200_1000',
    'tier_150_1200',
  ];
  const idx = order.indexOf(tierName);
  return idx >= 0 ? idx : 0;
}

export function isUpgrade(fromTier: string, toTier: string): boolean {
  return getTierOrder(toTier) > getTierOrder(fromTier);
}

export function isDowngrade(fromTier: string, toTier: string): boolean {
  return getTierOrder(toTier) < getTierOrder(fromTier);
}

// ─── RevenueCat (mobile billing — untouched) ─────────────────────────────────

const REVENUECAT_PRODUCT_MAPPING: Record<string, string> = {
  'kortix_plus_monthly': 'tier_2_20',
  'kortix_plus_yearly': 'tier_2_20',
  'plus:plus-monthly': 'tier_2_20',

  'kortix_pro_monthly': 'pro',
  'kortix_pro_yearly': 'pro',
  'pro:pro-monthly': 'pro',

  'kortix_ultra_monthly': 'tier_25_200',
  'kortix_ultra_yearly': 'tier_25_200',
  'ultra:ultra-monthly': 'tier_25_200',
};

export function mapRevenueCatProductToTier(productId: string): string | null {
  return REVENUECAT_PRODUCT_MAPPING[productId.toLowerCase()] ?? null;
}

export function getRevenueCatPeriodType(productId: string): 'monthly' | 'yearly' | 'yearly_commitment' {
  if (!productId) return 'monthly';
  const lower = productId.toLowerCase();
  if (lower.includes('commitment')) return 'yearly_commitment';
  if (lower.includes('yearly') || lower.includes('annual')) return 'yearly';
  return 'monthly';
}

export function isRevenueCatAnonymous(appUserId: string): boolean {
  return appUserId.startsWith('$RCAnonymousID:');
}
