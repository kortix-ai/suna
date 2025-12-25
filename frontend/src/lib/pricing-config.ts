import { config } from '@/lib/config';

interface UpgradePlan {
  /** @deprecated */
  hours: string;
  price: string;
  tierKey: string;  // Backend tier key
}

export interface PricingTier {
  name: string;
  price: string;
  yearlyPrice?: string;
  description: string;
  buttonText: string;
  buttonColor: string;
  isPopular: boolean;
  /** @deprecated */
  hours: string;
  features: string[];
  disabledFeatures?: string[];
  baseCredits?: number;
  bonusCredits?: number;
  tierKey: string;  // Backend tier key (e.g., 'tier_2_20', 'free')
  upgradePlans: UpgradePlan[];
  hidden?: boolean;
  billingPeriod?: 'monthly' | 'yearly';
  originalYearlyPrice?: string;
  discountPercentage?: number;
}

export const pricingTiers: PricingTier[] = [
  {
    name: 'Basic',
    price: '$0',
    yearlyPrice: '$0',
    originalYearlyPrice: '$0',
    discountPercentage: 0,
    description: 'Perfect for getting started',
    buttonText: 'Select',
    buttonColor: 'bg-secondary text-white',
    isPopular: false,
    hours: '0 hours',
    features: [
      '100 daily credits - Refreshes every 24 hours (applies to all tiers)',
      '1 concurrent run',
      '10 Total Chats',
      'Basic Mode - Core Kortix experience with basic autonomy',
    ],
    disabledFeatures: [
      'No custom AI Workers',
      'No scheduled triggers',
      'No app-based triggers',
      'No integrations',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.FREE_TIER.tierKey,
    upgradePlans: [],
  },
  {
    name: 'Plus',
    price: '$20',
    yearlyPrice: '$204',
    originalYearlyPrice: '$240',
    discountPercentage: 15,
    description: 'Best for individuals and small teams',
    buttonText: 'Get started',
    buttonColor: 'bg-primary text-white dark:text-black',
    isPopular: false,
    hours: '2 hours',
    baseCredits: 2000,
    bonusCredits: 2000,
    features: [
      'CREDITS_BONUS:2000:4000',
      'Unlimited Chats',
      '3 concurrent runs - Run multiple Chats simultaneously',
      '5 custom AI Workers - Create Kortix Workers with custom Knowledge, Tools & Integrations',
      '5 scheduled triggers - Run at 9am daily, every Monday, first of month...',
      '25 app triggers - Auto-respond to new emails, Slack messages, form submissions...',
      '100+ Integrations - Google Drive, Slack, Notion, Gmail, Calendar, GitHub & more',
      'Kortix Advanced mode - Strongest autonomy & decision-making capabilities',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.TIER_2_20.tierKey,
    upgradePlans: [],
  },
  {
    name: 'Pro',
    price: '$50',
    yearlyPrice: '$510',
    originalYearlyPrice: '$600',
    discountPercentage: 15,
    description: 'Ideal for growing businesses',
    buttonText: 'Get started',
    buttonColor: 'bg-secondary text-white',
    isPopular: false,
    hours: '6 hours',
    baseCredits: 5000,
    bonusCredits: 5000,
    features: [
      'CREDITS_BONUS:5000:10000',
      'Unlimited Chats',
      '5 concurrent runs - Run multiple Chats simultaneously',
      '20 custom AI Workers - Create Kortix Workers with custom Knowledge, Tools & Integrations',
      '10 scheduled triggers - Run at 9am daily, every Monday, first of month...',
      '50 app triggers - Auto-respond to new emails, Slack messages, form submissions...',
      '100+ Integrations - Google Drive, Slack, Notion, Gmail, Calendar, GitHub & more',
      'Kortix Advanced mode - Strongest autonomy & decision-making capabilities',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.TIER_6_50.tierKey,
    upgradePlans: [],
  },
  {
    name: 'Business',
    price: '$100',
    yearlyPrice: '$1020',
    originalYearlyPrice: '$1200',
    discountPercentage: 15,
    description: 'For established businesses',
    buttonText: 'Get started',
    buttonColor: 'bg-secondary text-white',
    isPopular: false,
    hours: '12 hours',
    features: [
      '10,000 credits/month',
      '20 custom workers',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.TIER_12_100.tierKey,
    upgradePlans: [],
    hidden: true,
  },
  {
    name: 'Ultra',
    price: '$200',
    yearlyPrice: '$2040',
    originalYearlyPrice: '$2400',
    discountPercentage: 15,
    description: 'For power users',
    buttonText: 'Get started',
    buttonColor: 'bg-secondary text-white',
    isPopular: false,
    hours: '25 hours',
    baseCredits: 20000,
    bonusCredits: 20000,
    features: [
      'CREDITS_BONUS:20000:40000',
      'Unlimited Chats',
      '20 concurrent runs - Run multiple Chats simultaneously',
      '100 custom AI Workers - Create Kortix Workers with custom Knowledge, Tools & Integrations',
      '50 scheduled triggers - Run at 9am daily, every Monday, first of month...',
      '200 app triggers - Auto-respond to new emails, Slack messages, form submissions...',
      '100+ Integrations - Google Drive, Slack, Notion, Gmail, Calendar, GitHub & more',
      'Kortix Advanced mode - Strongest autonomy & decision-making capabilities',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.TIER_25_200.tierKey,
    upgradePlans: [],
  },
  {
    name: 'Enterprise',
    price: '$400',
    yearlyPrice: '$4080',
    originalYearlyPrice: '$4800',
    discountPercentage: 15,
    description: 'For large teams',
    buttonText: 'Get started',
    buttonColor: 'bg-secondary text-white',
    isPopular: false,
    hours: '50 hours',
    features: [
      '40,000 credits/month',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
      'Priority support',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.TIER_50_400.tierKey,
    upgradePlans: [],
    hidden: true,
  },
  {
    name: 'Scale',
    price: '$800',
    yearlyPrice: '$8160',
    originalYearlyPrice: '$9600',
    discountPercentage: 15,
    description: 'For scaling teams',
    buttonText: 'Get started',
    buttonColor: 'bg-secondary text-white',
    isPopular: false,
    hours: '125 hours',
    features: [
      '80,000 credits/month',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
      'Priority support',
      'Dedicated account manager',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.TIER_125_800.tierKey,
    upgradePlans: [],
    hidden: true,
  },
  {
    name: 'Max',
    price: '$1000',
    yearlyPrice: '$10200',
    originalYearlyPrice: '$12000',
    discountPercentage: 15,
    description: 'Maximum performance',
    buttonText: 'Get started',
    buttonColor: 'bg-secondary text-white',
    isPopular: false,
    hours: '200 hours',
    features: [
      '100,000 credits/month',
      'Private projects',
      '100+ integrations',
      'Premium AI Models',
      'Priority support',
      'Dedicated account manager',
      'Custom deployment',
    ],
    tierKey: config.SUBSCRIPTION_TIERS.TIER_200_1000.tierKey,
    upgradePlans: [],
    hidden: true,
  },
];

