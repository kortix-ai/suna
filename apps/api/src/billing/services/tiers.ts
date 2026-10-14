import type Stripe from 'stripe';
import { config } from '../../config';
import type { TierConfig, TierEntitlements } from '../../types';
import { canonicalTier } from './tier-facts';

// Config-free tier facts live in their own module so genuinely pure consumers
// (billing-state.ts) can import them without booting env validation. Re-exported
// here so every `from './tiers'` import keeps working — one definition.
export {
  LEGACY_PAID_PLAN_KEYS,
  LEGACY_PAID_TIERS_UNMETERED,
  MINIMUM_CREDIT_FOR_RUN,
  PLAN_KEYS,
  accountRowMetersCompute,
  canonicalTier,
  isPaidTier,
  type PlanKey,
} from './tier-facts';

/** One-time credit grant per machine provisioned ($5 = 500 display credits). */
export const MACHINE_CREDIT_BONUS = 5;

/**
 * Margin multiplier applied to the live models.dev cost on every LLM gateway
 * call. 1.2 = 20% profit (default). Override per-environment with
 * KORTIX_LLM_MARKUP — useful for staging (1.0 = at-cost) or promotional
 * periods. Clamped to >= 1 so we never undercut the provider.
 */
const DEFAULT_LLM_PRICE_MARKUP = 1.2;

export function llmPriceMarkup(): number {
  const raw = Number.parseFloat(process.env.KORTIX_LLM_MARKUP ?? '');
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LLM_PRICE_MARKUP;
  return raw;
}

// ─── Credits-only billing ────────────────────────────────────────────────────
// One credit = $0.01. A paid account picks any monthly amount; every member
// spends from one shared wallet; plans differ only in credit volume. Free keeps
// $2 (200 credits) a month. See tier-facts.ts for the legacy plan keys.

/** Smallest and largest self-serve monthly amount, in whole dollars. */
export const PLAN_MIN_MONTHLY_USD = 50;
export const PLAN_MAX_MONTHLY_USD = 10_000;

/**
 * The tier ladder the product offers: named monthly amounts of the one credits
 * plan, same rate at every step. `popular` marks the most common paid amount
 * at or above the minimum. The API accepts any whole amount in range; the
 * ladder is what the UI sells.
 */
export const PLAN_PRESETS = [
  { monthlyUsd: 50 },
  { monthlyUsd: 100 },
  { monthlyUsd: 200, popular: true },
  { monthlyUsd: 300 },
  { monthlyUsd: 500 },
  { monthlyUsd: 750 },
  { monthlyUsd: 1_000 },
  { monthlyUsd: 1_500 },
  { monthlyUsd: 2_000 },
  { monthlyUsd: 3_000 },
  { monthlyUsd: 5_000 },
  { monthlyUsd: 7_500 },
  { monthlyUsd: 10_000 },
] as const;

export const MAX_PROJECTS_PER_ACCOUNT = 200;

// ─── Tiers ──────────────────────────────────────────────────────────────────

// Enterprise feature gates. The whole IAM surface — groups + custom
// roles/policies (`rbac`), the identity providers (SAML SSO + SCIM), and
// audit log access — is exclusive to the sales-assigned `enterprise` tier.
// Non-entitled accounts see an upsell in the UI and a 402 from the
// requireEntitlement() guard on create/update routes. See TierEntitlements.
const SELF_SERVE: TierEntitlements = {
  sso: false,
  scim: false,
  rbac: false,
  auditAccess: false,
  branding: false,
};
const ALL_ENTERPRISE: TierEntitlements = {
  sso: true,
  scim: true,
  rbac: true,
  auditAccess: true,
  branding: true,
};

/**
 * `monthlyCredits` is the FIXED allowance. `credits` has none: its allowance is
 * the account's chosen amount (`credit_accounts.plan_monthly_usd`), resolved
 * from the subscription by `monthlyCreditsForSubscription`.
 */
const TIERS: Record<string, TierConfig> = {
  none: {
    name: 'none',
    displayName: 'No Plan',
    monthlyCredits: 0,
    canPurchaseCredits: false,
    models: [],
    appLimit: 50,
    entitlements: SELF_SERVE,
  },

  free: {
    name: 'free',
    displayName: 'Free',
    monthlyCredits: 2,
    canPurchaseCredits: false,
    models: [],
    appLimit: 50,
    entitlements: SELF_SERVE,
  },

  // The highest App limit any legacy paid plan had, so nobody loses Apps when
  // their plan key folds into this one.
  credits: {
    name: 'credits',
    displayName: 'Credits',
    monthlyCredits: 0,
    canPurchaseCredits: true,
    models: ['all'],
    appLimit: 2000,
    entitlements: SELF_SERVE,
  },

  // Sales-assigned, never self-serve. Credits are granted per contract. The
  // only tier that unlocks the enterprise identity surfaces (SSO + SCIM).
  enterprise: {
    name: 'enterprise',
    displayName: 'Enterprise',
    monthlyCredits: 0,
    canPurchaseCredits: true,
    models: ['all'],
    appLimit: 5000,
    entitlements: ALL_ENTERPRISE,
  },
};

// ─── Stripe prices ───────────────────────────────────────────────────────────

interface StripePriceConfig {
  /** The $0 subscription every free account holds. */
  free: string;
  /** "Kortix credits": $0.01 per unit per month, quantity = credits. */
  credits: string;
  /** One-time top-up packages, by whole-dollar amount. */
  topUps: Record<number, string>;
}

const STRIPE_PRICES_PROD: StripePriceConfig = {
  free: 'price_1RIGvuG6l1KZGqIrw14abxeL',
  credits: 'price_1UQEUsG6l1KZGqIrSUPCdtIO', // live "Kortix credits", $0.01/credit/month
  topUps: {
    10: 'price_1RxmQUG6l1KZGqIru453O1zW',
    25: 'price_1RxmQlG6l1KZGqIr3hS5WtGg',
    50: 'price_1RxmQvG6l1KZGqIrLbMZ3D6r',
    100: 'price_1RxmR3G6l1KZGqIrpLwFCGac',
    250: 'price_1RxmRAG6l1KZGqIrtBIMsZAj',
    500: 'price_1RxmRGG6l1KZGqIrSyvl6w1G',
  },
};

// Staging and dev share the main Kortix Stripe account's TEST mode
// (acct_1R5BVvG6l1KZGqIr); both deployed keys are the same sk_test_ key.
const STRIPE_PRICES_STAGING: StripePriceConfig = {
  free: 'price_1RIGvuG6l1KZGqIrw14abxeL',
  credits: 'price_1UQERpG6l1KZGqIrIH1EuX7p',
  topUps: {
    10: 'price_1RxXOvG6l1KZGqIrMqsiYQvk',
    25: 'price_1RxXPNG6l1KZGqIrQprPgDme',
    50: 'price_1RxmNhG6l1KZGqIrTq2zPtgi',
    100: 'price_1RxmNwG6l1KZGqIrnliwPDM6',
    250: 'price_1RxmO6G6l1KZGqIrBF8Kx87G',
    500: 'price_1RxmOFG6l1KZGqIrn4wgORnH',
  },
};

const STRIPE_PRICES_DEV: StripePriceConfig = {
  free: 'price_1RIGvuG6l1KZGqIrw14abxeL',
  credits: 'price_1UQERpG6l1KZGqIrIH1EuX7p',
  topUps: {
    10: 'price_1TeyA8G6l1KZGqIrWYDbPN0O',
    25: 'price_1TeyA9G6l1KZGqIrbdZNyyDn',
    50: 'price_1TeyA9G6l1KZGqIrNbj3otrU',
    100: 'price_1TeyA9G6l1KZGqIrqSwPsznA',
    250: 'price_1TeyAAG6l1KZGqIrZavIxtSE',
    500: 'price_1TeyAAG6l1KZGqIrm5HnnDaT',
  },
};

/**
 * Every subscription price sold before credits-only billing, and the monthly
 * credits (USD) one unit of it grants. Existing subscriptions keep their price
 * and their bill; this table is what turns each into a monthly allowance.
 *
 * Monthly prices grant their price. Yearly prices grant the plan's MONTHLY
 * allowance (price ÷ 12 would cut a yearly customer's grant by the 15% yearly
 * discount). `per_seat` grants $40 per seat (it granted $25 before; same bill,
 * more credits).
 */
const LEGACY_PRICE_MONTHLY_USD: Record<string, number> = {
  // tier_2_20 "Plus" (also legacy `pro` monthly)
  price_1RILb4G6l1KZGqIrhomjgDnO: 20,
  price_1ReHB5G6l1KZGqIrD70I1xqM: 20,
  price_1RqtqiG6l1KZGqIrhjVPtE1s: 20,
  // tier_6_50 "Pro"
  price_1RILb4G6l1KZGqIr5q0sybWn: 50,
  price_1ReHAsG6l1KZGqIrlAog487C: 50,
  price_1Rqtr8G6l1KZGqIrQ0ql0qHi: 50,
  // tier_12_100 "Business"
  price_1RILb4G6l1KZGqIr5Y20ZLHm: 100,
  price_1ReHAWG6l1KZGqIrBHer2PQc: 100,
  // tier_25_200 "Ultra"
  price_1RILb4G6l1KZGqIrGAD8rNjb: 200,
  price_1ReH9uG6l1KZGqIrsvMLHViC: 200,
  price_1RqtrUG6l1KZGqIrEb8hLsk3: 200,
  // tier_50_400
  price_1RILb4G6l1KZGqIruNBUMTF1: 400,
  price_1ReH9fG6l1KZGqIrsPtu5KIA: 400,
  // tier_125_800
  price_1RILb3G6l1KZGqIrbJA766tN: 800,
  price_1ReH9GG6l1KZGqIrfgqaJyat: 800,
  // tier_200_1000 "Max"
  price_1RILb3G6l1KZGqIrmauYPOiN: 1000,
  price_1ReH8qG6l1KZGqIrK1akY90q: 1000,
  // per_seat, live and test, per seat
  price_1TdyruG6l1KZGqIrMzPVmQSO: 40,
  price_1TeyA7G6l1KZGqIrTb2DKGS0: 40,
  // legacy `pro`, test mode
  price_1TeyA7G6l1KZGqIr7ZhEpoVm: 20,
};

/** Legacy yearly prices sold with a 12-month commitment (no cancel before term). */
const YEARLY_COMMITMENT_PRICE_IDS = new Set([
  'price_1RqtqiG6l1KZGqIrhjVPtE1s',
  'price_1Rqtr8G6l1KZGqIrQ0ql0qHi',
  'price_1RqtrUG6l1KZGqIrEb8hLsk3',
]);

const ALL_PRICE_CONFIGS = [STRIPE_PRICES_PROD, STRIPE_PRICES_STAGING, STRIPE_PRICES_DEV];

function getStripePrices(): StripePriceConfig {
  switch (config.INTERNAL_KORTIX_ENV) {
    case 'prod':
      return STRIPE_PRICES_PROD;
    case 'staging':
      return STRIPE_PRICES_STAGING;
    default:
      return STRIPE_PRICES_DEV; // 'dev' / unset → local test sandbox
  }
}

/** The free plan's $0 price for this environment. */
export function resolveFreePriceId(): string {
  return getStripePrices().free;
}

/** The "Kortix credits" price for this environment. */
export function resolveCreditsPriceId(): string {
  return getStripePrices().credits;
}

export function resolveCreditPriceId(amountDollars: number): string | null {
  return getStripePrices().topUps[amountDollars] ?? null;
}

function isCreditsPrice(priceId: string): boolean {
  return ALL_PRICE_CONFIGS.some((c) => c.credits === priceId);
}

function isFreePrice(priceId: string): boolean {
  return ALL_PRICE_CONFIGS.some((c) => c.free === priceId);
}

/** The plan a subscription PRICE pays for. Unknown prices answer null. */
export function planForPrice(priceId: string | null | undefined): 'free' | 'credits' | null {
  if (!priceId) return null;
  if (isFreePrice(priceId)) return 'free';
  if (isCreditsPrice(priceId) || priceId in LEGACY_PRICE_MONTHLY_USD) return 'credits';
  return null;
}

type SubscriptionItemLike = Pick<Stripe.SubscriptionItem, 'quantity'> & {
  price?: Pick<Stripe.Price, 'id' | 'unit_amount' | 'recurring'> | null;
};

/**
 * The plan a SUBSCRIPTION pays for — the only trustworthy answer to "which plan
 * did this customer buy". The price decides; our own metadata is the fallback
 * for prices this table never saw (legacy machine subscriptions).
 */
export function planForSubscription(subscription: {
  items: { data: SubscriptionItemLike[] };
  metadata?: Stripe.Metadata | null;
}): 'free' | 'credits' | 'enterprise' | null {
  for (const item of subscription.items.data) {
    const plan = planForPrice(item.price?.id);
    if (plan) return plan;
  }
  const hint = canonicalTier(subscription.metadata?.plan_key || subscription.metadata?.tier_key);
  return hint === 'none' ? null : hint;
}

/**
 * THE allowance rule: the credits (USD) one month of this subscription grants.
 * Σ items: monthly credits per unit × quantity. Discounts do not reduce it —
 * the allowance is what the plan lists, as the seat rule always was.
 *
 *   - "Kortix credits": $0.01 × quantity.
 *   - A legacy price: its row in LEGACY_PRICE_MONTHLY_USD.
 *   - Any other price (a legacy machine subscription): its list price per month.
 *
 * Pure — testable without Stripe or a DB.
 */
export function monthlyCreditsForSubscription(subscription: {
  items: { data: SubscriptionItemLike[] };
}): number {
  let cents = 0;
  for (const item of subscription.items.data) {
    const quantity = Math.max(0, item.quantity ?? 1);
    const price = item.price;
    if (!price) continue;
    if (isCreditsPrice(price.id)) cents += quantity;
    else if (price.id in LEGACY_PRICE_MONTHLY_USD) cents += LEGACY_PRICE_MONTHLY_USD[price.id] * 100 * quantity;
    else {
      const perMonth = price.recurring?.interval === 'year' ? (price.unit_amount ?? 0) / 12 : (price.unit_amount ?? 0);
      cents += Math.round(perMonth) * quantity;
    }
  }
  return cents / 100;
}

/** Billing period of a subscription's first item. */
export function billingPeriodForSubscription(subscription: {
  items: { data: SubscriptionItemLike[] };
}): 'monthly' | 'yearly' | 'yearly_commitment' {
  const price = subscription.items.data[0]?.price;
  if (price && YEARLY_COMMITMENT_PRICE_IDS.has(price.id)) return 'yearly_commitment';
  return price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
}

/**
 * Monthly allowance of a row written before credits-only billing, which has no
 * `plan_monthly_usd` yet: the legacy plan's price, or $40 per seat.
 * ponytail: transitional; delete once the backfill has written every paid row.
 */
const LEGACY_TIER_MONTHLY_USD: Record<string, number> = {
  pro: 20,
  tier_2_20: 20,
  tier_6_50: 50,
  tier_12_100: 100,
  tier_25_200: 200,
  tier_50_400: 400,
  tier_125_800: 800,
  tier_200_1000: 1000,
  tier_150_1200: 1200,
};

/** The monthly allowance (USD) an account's plan grants. */
export function planMonthlyUsd(row: {
  tier?: string | null;
  planMonthlyUsd?: string | number | null;
  seatCount?: number | null;
}): number {
  const stored = Number(row.planMonthlyUsd);
  if (row.planMonthlyUsd != null && Number.isFinite(stored)) return stored;
  const tier = row.tier ?? 'none';
  if (tier === 'per_seat') return 40 * Math.max(1, row.seatCount ?? 1);
  return LEGACY_TIER_MONTHLY_USD[tier] ?? getTier(tier).monthlyCredits;
}

/**
 * The monthly allowance of a PAID account billed by `subscription`. The
 * subscription's list price decides, except for a comped account: support
 * assigns a paid plan to an account that stays on a $0 price, and that account
 * keeps its stored (or legacy) monthly amount.
 */
export function paidMonthlyUsd(
  subscription: { items: { data: SubscriptionItemLike[] } },
  row: Parameters<typeof planMonthlyUsd>[0] | null | undefined,
): number {
  const fromSubscription = monthlyCreditsForSubscription(subscription);
  return fromSubscription > 0 || !row ? fromSubscription : planMonthlyUsd(row);
}

// ─── Tier helpers ────────────────────────────────────────────────────────────

/** The plan config a stored tier key means. Legacy keys resolve to `credits`. */
export function getTier(name: string): TierConfig {
  return TIERS[canonicalTier(name)];
}

export function isValidTier(name: string): boolean {
  return name in TIERS;
}

/**
 * Whether a tier unlocks the full model catalog — the premium LLM gateway
 * (Claude/GPT/Gemini/…), not just OpenCode's built-in models. Pure function of
 * tier config: environment and wallet balance cannot grant it.
 */
export function tierGrantsAllModels(tierName: string): boolean {
  return getTier(tierName).models.includes('all');
}

/** Full entitlement set for a tier (enterprise feature gates). */
export function getTierEntitlements(tierName: string): TierEntitlements {
  return getTier(tierName).entitlements;
}

// ─── RevenueCat (mobile in-app purchases) ────────────────────────────────────
// The store sells fixed products, so mobile keeps them. Each maps to `credits`
// with the monthly allowance it grants.

const REVENUECAT_PRODUCT_MONTHLY_USD: Record<string, number> = {
  kortix_plus_monthly: 20,
  kortix_plus_yearly: 20,
  'plus:plus-monthly': 20,
  plus: 20,
  kortix_pro_monthly: 20,
  kortix_pro_yearly: 20,
  'pro:pro-monthly': 20,
  kortix_ultra_monthly: 200,
  kortix_ultra_yearly: 200,
  'ultra:ultra-monthly': 200,
};

/** Monthly allowance (USD) of a RevenueCat product, or null when the product is unknown. */
export function revenueCatProductMonthlyUsd(productId: string): number | null {
  return REVENUECAT_PRODUCT_MONTHLY_USD[productId.toLowerCase()] ?? null;
}

export function getRevenueCatPeriodType(
  productId: string,
): 'monthly' | 'yearly' | 'yearly_commitment' {
  if (!productId) return 'monthly';
  const lower = productId.toLowerCase();
  if (lower.includes('commitment')) return 'yearly_commitment';
  if (lower.includes('yearly') || lower.includes('annual')) return 'yearly';
  return 'monthly';
}

export function isRevenueCatAnonymous(appUserId: string): boolean {
  return appUserId.startsWith('$RCAnonymousID:');
}
