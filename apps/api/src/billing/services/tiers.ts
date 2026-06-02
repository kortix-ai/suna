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

/**
 * Margin multiplier applied to OpenRouter's upstream cost on every LLM
 * gateway call. 1.2 = 20% margin (default). Override per-environment with
 * KORTIX_LLM_MARKUP — useful for staging (1.0 = at-cost) or promotional
 * periods. Clamped to >= 1 so we never undercut OpenRouter.
 */
export const DEFAULT_LLM_PRICE_MARKUP = 1.2;

export function llmPriceMarkup(): number {
  const raw = Number.parseFloat(process.env.KORTIX_LLM_MARKUP ?? '');
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LLM_PRICE_MARKUP;
  return raw;
}

// ─── Billing v2 — per-seat model ─────────────────────────────────────────────
// Every new account is born on the per-seat plan — there is no free tier
// for new signups. Existing 'free' / 'legacy' tier accounts are preserved
// (billing_model='legacy') but new accounts get billing_model='per_seat'
// from the setup flow.
//
// Each account is billed $20/month × number of accepted account_members.
// $20 grants $20 of fungible wallet credits — there's NO separate compute/
// LLM bucket in the wallet. Spend is debited from the unified balance; the
// credit_ledger.type tag (`compute_debit` / `llm_debit`) drives the UI
// usage breakdown.
//
// The two TYPICAL_* constants below are display-only — surfaced on the
// pricing page as "roughly N hours of compute or M tokens" rough guidance,
// not enforced anywhere.

export const PER_SEAT_PRICE_USD = 20;
/** Display-only: rough indication for pricing-page copy. */
export const TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD = 12;
/** Display-only: rough indication for pricing-page copy. */
export const TYPICAL_LLM_BUDGET_PER_SEAT_USD = 8;

// Per-second sandbox compute pricing, keyed off the reserved spec (kortix.toml
// [sandbox]). The constants below are Daytona's PUBLISHED LIST rates (kept as
// list so they're easy to re-sync from the pricing page). Our ACTUAL cost is
// list × the volume discount Daytona gives us (DAYTONA_DISCOUNT). The debit
// emitter charges:
//     cost = spec × list_rate × DAYTONA_DISCOUNT × COMPUTE_PRICE_MARKUP
// i.e. we pass the discount through (cheaper for users) and keep a margin on top.
// Daytona list (https://www.daytona.io/pricing, as of 2026-06):
//   vCPU  $0.0504 / core-hour → 0.000014   per core-second
//   RAM   $0.0162 / GiB-hour  → 0.0000045  per GB-second
//   disk  $0.000108 / GiB-hour→ 0.00000003 per GB-second
// We bill the full reserved spec — Daytona's first-5-GiB-free RAM/disk allowance
// is an ORG-level promo to us, not a per-sandbox grant, so passing it per sandbox
// would under-bill.
export const COMPUTE_CPU_PRICE_PER_CORE_SECOND   = 0.000014;
export const COMPUTE_MEMORY_PRICE_PER_GB_SECOND  = 0.0000045;
export const COMPUTE_DISK_PRICE_PER_GB_SECOND    = 0.00000003;
/** Volume discount Daytona gives us off list (≈50%) → our real cost = list ×
 *  this. Applied before the markup so users are billed on our actual (discounted)
 *  cost, not Daytona's list. Bump toward 1.0 if the discount shrinks. */
export const DAYTONA_DISCOUNT = 0.5;
/** Stopped-but-not-destroyed sandboxes pay a fraction of the disk rate. v2: not billed; reserved for future. */
export const COMPUTE_ARCHIVE_DISK_MULTIPLIER     = 0.25;

// Auto-topup defaults for per-seat accounts scale with seat count.
// effectiveThreshold = AUTO_TOPUP_DEFAULT_THRESHOLD_PER_SEAT × seat_count
// effectiveAmount    = AUTO_TOPUP_DEFAULT_AMOUNT_PER_SEAT × seat_count
//   threshold = 25% of one seat (top up when wallet has < 1/4 seat-month left)
//   amount    = 1 seat-month (refill the equivalent of one seat)
// Legacy accounts keep their flat $5/$20 (auto_topup_customized=true or just unaffected).
export const AUTO_TOPUP_DEFAULT_THRESHOLD_PER_SEAT = 5;
export const AUTO_TOPUP_DEFAULT_AMOUNT_PER_SEAT    = 20;

// Sensible caps for the per-seat plan. Effectively uncapped for normal use.
export const MAX_PROJECTS_PER_ACCOUNT       = 200;
export const MAX_CONCURRENT_SANDBOXES_PER_SEAT = 3;
export const MAX_SEATS_PER_ACCOUNT          = 100;

export type BillingModel = 'legacy' | 'per_seat';

/** Default auto-topup for a per-seat account given its current seat count. */
export function defaultAutoTopupForSeats(seatCount: number): { threshold: number; amount: number } {
  const seats = Math.max(1, seatCount);
  return {
    threshold: AUTO_TOPUP_DEFAULT_THRESHOLD_PER_SEAT * seats,
    amount: AUTO_TOPUP_DEFAULT_AMOUNT_PER_SEAT * seats,
  };
}

/**
 * Monthly wallet grant for N seats. $20 per seat, fungible across compute
 * and LLM usage. Per-category transparency comes from the credit_ledger
 * (compute_debit / llm_debit), not from a wallet partition.
 */
export function grantForSeats(seatCount: number): number {
  return PER_SEAT_PRICE_USD * Math.max(1, seatCount);
}

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
    concurrentSessionLimit: 50,
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
    // Hidden from new signup flows. Existing rows with tier='free' continue
    // to be honored for backwards compatibility (they remain billing_model='legacy').
    hidden: true,
    concurrentSessionLimit: 50,
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
    concurrentSessionLimit: 200,
  },

  // Billing v2 — per-member seat plan. $20 × seat_count / month.
  // The TIERS entry models a single seat; multi-seat math is in
  // grantForSeats() and applied at subscription create + renew.
  per_seat: {
    name: 'per_seat',
    displayName: 'Team',
    monthlyPrice: PER_SEAT_PRICE_USD,
    yearlyPrice: 0,
    monthlyCredits: PER_SEAT_PRICE_USD,
    canPurchaseCredits: true,
    models: ['all'],
    dailyCreditConfig: null,
    hidden: false,
    concurrentSessionLimit: 200,
  },

  // ── Legacy tiers (kept for backward compat with existing DB rows) ────────
  // All hidden, resolve to their closest equivalent for display.
  // Legacy tiers: monthlyCredits = monthlyPrice (1:1 ratio, i.e. $20 plan → $20 credits → 2000 display credits)
  tier_2_20:      { name: 'tier_2_20',      displayName: 'Plus (Legacy)',       monthlyPrice: 20,   yearlyPrice: 204,   monthlyCredits: 20,   canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 200 },
  tier_6_50:      { name: 'tier_6_50',      displayName: 'Pro (Legacy)',        monthlyPrice: 50,   yearlyPrice: 510,   monthlyCredits: 50,   canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 300 },
  tier_12_100:    { name: 'tier_12_100',    displayName: 'Business (Legacy)',   monthlyPrice: 100,  yearlyPrice: 1020,  monthlyCredits: 100,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 400 },
  tier_25_200:    { name: 'tier_25_200',    displayName: 'Ultra (Legacy)',      monthlyPrice: 200,  yearlyPrice: 2040,  monthlyCredits: 200,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 500 },
  tier_50_400:    { name: 'tier_50_400',    displayName: 'Enterprise (Legacy)', monthlyPrice: 400,  yearlyPrice: 4080,  monthlyCredits: 400,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 750 },
  tier_125_800:   { name: 'tier_125_800',   displayName: 'Scale (Legacy)',      monthlyPrice: 800,  yearlyPrice: 8160,  monthlyCredits: 800,  canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 1000 },
  tier_200_1000:  { name: 'tier_200_1000',  displayName: 'Max (Legacy)',        monthlyPrice: 1000, yearlyPrice: 10200, monthlyCredits: 1000, canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 1500 },
  tier_150_1200:  { name: 'tier_150_1200',  displayName: 'Enterprise Max (Legacy)', monthlyPrice: 1200, yearlyPrice: 12240, monthlyCredits: 1200, canPurchaseCredits: true, models: ['all'], dailyCreditConfig: null, hidden: true, concurrentSessionLimit: 2000 },
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

// TODO(billing-v2-ops): create the per-seat Stripe price in prod + staging.
//   - Recurring monthly, $20 USD per unit, unit = 1 seat.
//   - Replace the PLACEHOLDER below with the resulting price IDs before deploy.
//   - Webhook handler for customer.subscription.updated (services/webhooks.ts)
//     reconciles the `quantity` field on this price item into credit_accounts.seat_count.
const STRIPE_PRICES_PROD: StripePriceConfig = {
  subscriptions: {
    free: { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    pro:  { monthly: 'price_1RILb4G6l1KZGqIrhomjgDnO' }, // TODO: create prod Pro price and replace
    per_seat: { monthly: 'price_1TcrQJG6l1KZGqIry1K1cqZY' }, // live "Kortix seat" $20/mo
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
    free: { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    pro:  { monthly: 'price_1T7yiuG6CaZppiKc7VsgnlKI' },
    // Billing v2 — $20/month per-seat in the staging Stripe account (acct_…G6CaZppiKc),
    // the same account the staging customers + their legacy subs live in (so the
    // migration can actually find/cancel them). The old …G6l1KZGqIr price was in a
    // different account and is being deprecated.
    per_seat: { monthly: 'price_1TdSdvG6CaZppiKctAZXPPY0' },
  },
  credits: {
    10:  'price_1RxXOvG6l1KZGqIrMqsiYQvk',
    25:  'price_1RxXPNG6l1KZGqIrQprPgDme',
    50:  'price_1RxmNhG6l1KZGqIrTq2zPtgi',
    100: 'price_1RxmNwG6l1KZGqIrnliwPDM6',
    250: 'price_1RxmO6G6l1KZGqIrBF8Kx87G',
    500: 'price_1RxmOFG6l1KZGqIrn4wgORnH',
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

/** Returns true if the tier is a paid tier (not free/none). */
export function isPaidTier(tierName: string): boolean {
  return tierName !== 'free' && tierName !== 'none';
}

/** Returns the per-seat Stripe price ID for the current environment. */
export function resolvePerSeatPriceId(): string | null {
  const prices = getStripePrices();
  return prices.subscriptions.per_seat?.monthly ?? null;
}

/**
 * Per-seat code paths must no-op for legacy customers. Use this guard at every
 * branch that would otherwise mutate Stripe quantity / grant seat credits /
 * meter compute / mint per-member YOLO tokens.
 */
export function isPerSeatAccount(billingModel: string | null | undefined): boolean {
  return billingModel === 'per_seat';
}

export function isLegacyAccount(billingModel: string | null | undefined): boolean {
  // Default for null/undefined is legacy — safer to skip new behaviour than to
  // accidentally bill a legacy customer twice.
  return billingModel !== 'per_seat';
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
