// Environment mode types
export enum EnvMode {
  LOCAL = 'local',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

// Subscription tier structure - tier keys only, no price IDs
export interface SubscriptionTierData {
  tierKey: string;  // Backend tier key like 'free', 'tier_2_20', etc.
  name: string;     // Display name like 'Basic', 'Plus', 'Pro'
}

// Subscription tiers structure - ONLY tier keys, price IDs come from backend
export interface SubscriptionTiers {
  FREE_TIER: SubscriptionTierData;
  TIER_2_20: SubscriptionTierData;
  TIER_6_50: SubscriptionTierData;
  TIER_12_100: SubscriptionTierData;
  TIER_25_200: SubscriptionTierData;
  TIER_50_400: SubscriptionTierData;
  TIER_125_800: SubscriptionTierData;
  TIER_200_1000: SubscriptionTierData;
}

// Configuration object
interface Config {
  ENV_MODE: EnvMode;
  IS_LOCAL: boolean;
  IS_STAGING: boolean;
  SUBSCRIPTION_TIERS: SubscriptionTiers;
}

// Tier keys - single source, no environment-specific price IDs
const TIERS: SubscriptionTiers = {
  FREE_TIER: {
    tierKey: 'free',
    name: 'Basic/$0',
  },
  TIER_2_20: {
    tierKey: 'tier_2_20',
    name: 'Plus/$20',
  },
  TIER_6_50: {
    tierKey: 'tier_6_50',
    name: 'Pro/$50',
  },
  TIER_12_100: {
    tierKey: 'tier_12_100',
    name: 'Business/$100',
  },
  TIER_25_200: {
    tierKey: 'tier_25_200',
    name: 'Ultra/$200',
  },
  TIER_50_400: {
    tierKey: 'tier_50_400',
    name: 'Enterprise/$400',
  },
  TIER_125_800: {
    tierKey: 'tier_125_800',
    name: 'Scale/$800',
  },
  TIER_200_1000: {
    tierKey: 'tier_200_1000',
    name: 'Max/$1000',
  },
} as const;

function getEnvironmentMode(): EnvMode {
  const envMode = process.env.NEXT_PUBLIC_ENV_MODE?.toUpperCase();
  switch (envMode) {
    case 'LOCAL':
      return EnvMode.LOCAL;
    case 'STAGING':
      return EnvMode.STAGING;
    case 'PRODUCTION':
      return EnvMode.PRODUCTION;
    default:
      return EnvMode.LOCAL;
  }
}

const currentEnvMode = getEnvironmentMode();

export const config: Config = {
  ENV_MODE: currentEnvMode,
  IS_LOCAL: currentEnvMode === EnvMode.LOCAL,
  IS_STAGING: currentEnvMode === EnvMode.STAGING,
  SUBSCRIPTION_TIERS: TIERS,  // Same tiers for all environments
};

export const isLocalMode = (): boolean => {
  return config.IS_LOCAL;
};

export const isStagingMode = (): boolean => {
  return config.IS_STAGING;
};

export const isProductionMode = (): boolean => {
  return config.ENV_MODE === EnvMode.PRODUCTION;
};
