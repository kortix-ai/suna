/**
 * Ids for the MARKETING plan cards. DISPLAY-ONLY.
 *
 * These are React keys and copy lookups for the three cards on /pricing and the
 * cards in the upgrade modal. They are NOT billing identifiers and must never
 * be compared against an API tier key, `subscription.tier_key`, a Stripe
 * price/product id, or an entitlement key. To branch on what an account is
 * actually on, use `resolvedPlan(accountState)` from `@kortix/sdk`.
 *
 * `PRICING_PLANS` is the English source for server-rendered surfaces that
 * cannot call a translation hook: the JSON-LD offers in the root layout and the
 * `/markdown/pricing.md` page. The pages themselves read the same copy from
 * `billing.pricing.plans.*` in the translation catalogs through
 * `usePricingPlans()`. `pricing-copy.test.ts` fails when the two differ.
 */
export type PricingPlanId = 'free' | 'credits' | 'enterprise';

export type PricingPlan = {
  id: PricingPlanId;
  name: string;
  price: string;
  unit?: string;
  note: string;
  highlight?: boolean;
  features: string[];
};

/** How many `f<n>` feature keys each plan has in the catalogs. */
export const PRICING_FEATURE_COUNTS: Record<PricingPlanId, number> = {
  free: 4,
  credits: 6,
  enterprise: 6,
};

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    note: 'Start with real sandbox credits.',
    features: [
      '200 credits / month, no card needed',
      '1 project',
      'Bring your own API key for any premium model',
      'Connect your ChatGPT subscription',
    ],
  },
  {
    id: 'credits',
    name: 'Credits',
    price: '$50',
    unit: '/ month and up',
    note: 'From $50 a month. Pick the credits your team needs.',
    highlight: true,
    features: [
      'Everything in Free',
      'Unlimited members, one shared credit pool',
      'Unused credits roll over one month',
      'Top up any time. Top-ups never expire',
      'Managed models and every feature',
      'Support via email',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    note: 'Scale, security, and your deployment.',
    features: [
      'Everything in Credits',
      'SAML SSO + SCIM directory sync',
      'Advanced RBAC + audit logs',
      'Cloud, VPC, or on-prem',
      'BYOK, ChatGPT subscription, and managed model controls',
      'SLA, DPA & dedicated support',
    ],
  },
];
