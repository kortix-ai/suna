/**
 * Pricing Configuration
 *
 * Display-only plan cards. Mirrors apps/web/src/features/billing/pricing-plans.ts.
 */

import { SparkleIcon as Sparkles, UsersIcon as Users, BuildingsIcon as Building2 } from '@/lib/icons';

// =============================================================================
// WEB-SYNCED PLANS (credits-only)
//
// Source of truth: apps/web/src/features/billing/pricing-plans.ts
// Mobile has NO in-app purchase — plans are display-only and the "Get Started"
// button sends users to the web pricing page to subscribe. Keep this array in
// sync with the web file above; only `icon` is mobile-specific.
// =============================================================================

export type PricingPlanId = 'free' | 'credits' | 'enterprise';

export type UpgradeModalPlanId = Exclude<PricingPlanId, 'enterprise'>;

export interface PricingPlan {
  id: PricingPlanId;
  name: string;
  price: string;
  unit?: string;
  note: string;
  highlight?: boolean;
  features: string[];
  icon?: any; // mobile-only: React component for the card icon
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    note: 'Start with real sandbox credits.',
    icon: Sparkles,
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
    icon: Users,
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
    icon: Building2,
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

/** Plans shown in the in-app upgrade surface — action-focused, no Enterprise card. */
export const UPGRADE_MODAL_PLANS = PRICING_PLANS.filter(
  (plan): plan is PricingPlan & { id: UpgradeModalPlanId } => plan.id !== 'enterprise',
);
