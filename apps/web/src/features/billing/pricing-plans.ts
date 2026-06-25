export type PricingPlanId = 'free' | 'team' | 'enterprise';

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
};

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    note: 'Start with real sandbox credits.',
    features: [
      '500 credits / month for sandbox compute only',
      'Free OpenCode models included',
      'Bring your own API key for any premium model',
      'Connect your ChatGPT subscription',
      'Credits reset monthly',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    price: '$40',
    unit: '/ seat / mo',
    note: 'For teams running real work on agents.',
    highlight: true,
    badge: 'Most popular',
    features: [
      '$20 of usage credits per seat, pooled',
      'Managed frontier models included',
      'BYOK and ChatGPT subscription still supported',
      'Up to 200 projects, up to 100 seats',
      'Top up credits anytime',
      'Standard support',
    ],
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
