/**
 * Ids for the MARKETING plan cards. DISPLAY-ONLY.
 *
 * These are React keys and copy lookups for the three cards on /pricing and the
 * two in the upgrade modal. They are NOT billing identifiers and must never be
 * compared against an API tier key, `subscription.tier_key`, `billing_model`, a
 * Stripe price/product id, or an entitlement key.
 *
 * `'team_seat'` is spelled out for exactly that reason: the card it names is the
 * live $40/seat per-seat offer (`billing_model === 'per_seat'`), while the API
 * key `team` is the RETIRED $200 flat plan. The id used to be `'team'`, so the
 * same six letters meant two different products depending on which file you
 * were reading. To branch on what an account is actually on, use
 * `resolvedPlan(accountState)` from `@kortix/sdk` — not one of these ids.
 */
export type PricingPlanId = 'free' | 'team_seat' | 'enterprise';

export type UpgradeModalPlanId = Exclude<PricingPlanId, 'enterprise'>;

export type PricingPlan = {
  id: PricingPlanId;
  name: string;
  price: string;
  unit?: string;
  note: string;
  highlight?: boolean;
  badge?: string;
  features: string[];
  featureDetails?: Record<string, string>;
};

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    note: 'Start with real sandbox credits.',
    features: [
      '200 credits / month for sandbox compute',
      '1 project',
      'Bring your own API key for any premium model',
      'Connect your ChatGPT subscription',
    ],
  },
  {
    id: 'team_seat',
    name: 'Team',
    price: '$40',
    unit: '/ seat / mo',
    note: 'For teams running real work on agents.',
    highlight: true,
    badge: 'Most popular',
    features: [
      'Everything in Free',
      '2,500 credits / month per seat, pooled',
      'Optional managed models use pooled credits',
      'BYOK and ChatGPT subscription still supported',
      'Up to 200 projects, up to 100 seats',
      'Top up credits anytime',
      'Support via email',
    ],
    featureDetails: {
      '2,500 credits / month per seat, pooled':
        'About 125 default Agent Computer hours when used only for compute.',
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    note: 'Scale, security, and your deployment.',
    features: [
      'Everything in Team',
      'SAML SSO + SCIM directory sync',
      'Advanced RBAC + audit logs',
      'Cloud, VPC, or on-prem',
      'BYOK, ChatGPT subscription, and managed model controls',
      'SLA, DPA & dedicated support',
    ],
  },
];

/** Plans shown in the in-app upgrade modal — action-focused, no Enterprise card. */
export const UPGRADE_MODAL_PLANS = PRICING_PLANS.filter(
  (plan): plan is PricingPlan & { id: UpgradeModalPlanId } => plan.id !== 'enterprise',
);
