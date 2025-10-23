// Environment mode types
export enum EnvMode {
  LOCAL = 'local',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

// Subscription tier structure
export interface SubscriptionTierData {
  priceId: string;
  name: string;
}

// Subscription tiers structure
export interface SubscriptionTiers {
  TIER_2_20: SubscriptionTierData;
  TIER_6_50: SubscriptionTierData;
  TIER_12_100: SubscriptionTierData;
  TIER_25_200: SubscriptionTierData;
  TIER_50_400: SubscriptionTierData;
  TIER_125_800: SubscriptionTierData;
  TIER_200_1000: SubscriptionTierData;
  // Yearly plans with 15% discount
  TIER_2_20_YEARLY: SubscriptionTierData;
  TIER_6_50_YEARLY: SubscriptionTierData;
  TIER_12_100_YEARLY: SubscriptionTierData;
  TIER_25_200_YEARLY: SubscriptionTierData;
  TIER_50_400_YEARLY: SubscriptionTierData;
  TIER_125_800_YEARLY: SubscriptionTierData;
  TIER_200_1000_YEARLY: SubscriptionTierData;
  // Yearly commitment plans (15% discount, monthly payments with 12-month commitment)
  TIER_2_17_YEARLY_COMMITMENT: SubscriptionTierData;
  TIER_6_42_YEARLY_COMMITMENT: SubscriptionTierData;
  TIER_25_170_YEARLY_COMMITMENT: SubscriptionTierData;
}

// Configuration object
interface Config {
  ENV_MODE: EnvMode;
  IS_LOCAL: boolean;
  IS_STAGING: boolean;
  SUBSCRIPTION_TIERS: SubscriptionTiers;
}

// Production tier IDs
const PROD_TIERS: SubscriptionTiers = {
  TIER_2_20: {
    priceId: 'price_1RILb4G6l1KZGqIrhomjgDnO',
    name: '2h/$20',
  },
  TIER_6_50: {
    priceId: 'price_1RILb4G6l1KZGqIr5q0sybWn',
    name: '6h/$50',
  },
  TIER_12_100: {
    priceId: 'price_1RILb4G6l1KZGqIr5Y20ZLHm',
    name: '12h/$100',
  },
  TIER_25_200: {
    priceId: 'price_1RILb4G6l1KZGqIrGAD8rNjb',
    name: '25h/$200',
  },
  TIER_50_400: {
    priceId: 'price_1RILb4G6l1KZGqIruNBUMTF1',
    name: '50h/$400',
  },
  TIER_125_800: {
    priceId: 'price_1RILb3G6l1KZGqIrbJA766tN',
    name: '125h/$800',
  },
  TIER_200_1000: {
    priceId: 'price_1RILb3G6l1KZGqIrmauYPOiN',
    name: '200h/$1000',
  },
  // Legacy yearly plans with 15% discount (12x monthly price with 15% off)
  TIER_2_20_YEARLY: {
    priceId: 'price_1ReHB5G6l1KZGqIrD70I1xqM',
    name: '2h/$204/year (legacy)',
  },
  TIER_6_50_YEARLY: {
    priceId: 'price_1ReHAsG6l1KZGqIrlAog487C',
    name: '6h/$510/year (legacy)',
  },
  TIER_12_100_YEARLY: {
    priceId: 'price_1ReHAWG6l1KZGqIrBHer2PQc',
    name: '12h/$1020/year (legacy)',
  },
  TIER_25_200_YEARLY: {
    priceId: 'price_1ReH9uG6l1KZGqIrsvMLHViC',
    name: '25h/$2040/year (legacy)',
  },
  TIER_50_400_YEARLY: {
    priceId: 'price_1ReH9fG6l1KZGqIrsPtu5KIA',
    name: '50h/$4080/year (legacy)',
  },
  TIER_125_800_YEARLY: {
    priceId: 'price_1ReH9GG6l1KZGqIrfgqaJyat',
    name: '125h/$8160/year (legacy)',
  },
  TIER_200_1000_YEARLY: {
    priceId: 'price_1ReH8qG6l1KZGqIrK1akY90q',
    name: '200h/$10200/year (legacy)',
  },
  // Yearly commitment plans (15% discount, monthly payments with 12-month commitment)
  TIER_2_17_YEARLY_COMMITMENT: {
    priceId: 'price_1RqtqiG6l1KZGqIrhjVPtE1s',
    name: '2h/$17/month (yearly)',
  },
  TIER_6_42_YEARLY_COMMITMENT: {
    priceId: 'price_1Rqtr8G6l1KZGqIrQ0ql0qHi',
    name: '6h/$42.50/month (yearly)',
  },
  TIER_25_170_YEARLY_COMMITMENT: {
    priceId: 'price_1RqtrUG6l1KZGqIrEb8hLsk3',
    name: '25h/$170/month (yearly)',
  },
} as const;

// Staging tier IDs
const STAGING_TIERS: SubscriptionTiers = {
  TIER_2_20: {
    priceId: 'price_1RIGvuG6l1KZGqIrCRu0E4Gi',
    name: '2h/$20',
  },
  TIER_6_50: {
    priceId: 'price_1RIGvuG6l1KZGqIrvjlz5p5V',
    name: '6h/$50',
  },
  TIER_12_100: {
    priceId: 'price_1RIGvuG6l1KZGqIrT6UfgblC',
    name: '12h/$100',
  },
  TIER_25_200: {
    priceId: 'price_1RIGvuG6l1KZGqIrOVLKlOMj',
    name: '25h/$200',
  },
  TIER_50_400: {
    priceId: 'price_1RIKNgG6l1KZGqIrvsat5PW7',
    name: '50h/$400',
  },
  TIER_125_800: {
    priceId: 'price_1RIKNrG6l1KZGqIrjKT0yGvI',
    name: '125h/$800',
  },
  TIER_200_1000: {
    priceId: 'price_1RIKQ2G6l1KZGqIrum9n8SI7',
    name: '200h/$1000',
  },
  // Legacy yearly plans with 15% discount (12x monthly price with 15% off)
  TIER_2_20_YEARLY: {
    priceId: 'price_1ReGogG6l1KZGqIrEyBTmtPk',
    name: '2h/$204/year (legacy)',
  },
  TIER_6_50_YEARLY: {
    priceId: 'price_1ReGoJG6l1KZGqIr0DJWtoOc',
    name: '6h/$510/year (legacy)',
  },
  TIER_12_100_YEARLY: {
    priceId: 'price_1ReGnZG6l1KZGqIr0ThLEl5S',
    name: '12h/$1020/year (legacy)',
  },
  TIER_25_200_YEARLY: {
    priceId: 'price_1ReGmzG6l1KZGqIre31mqoEJ',
    name: '25h/$2040/year (legacy)',
  },
  TIER_50_400_YEARLY: {
    priceId: 'price_1ReGmgG6l1KZGqIrn5nBc7e5',
    name: '50h/$4080/year (legacy)',
  },
  TIER_125_800_YEARLY: {
    priceId: 'price_1ReGmMG6l1KZGqIrvE2ycrAX',
    name: '125h/$8160/year (legacy)',
  },
  TIER_200_1000_YEARLY: {
    priceId: 'price_1ReGlXG6l1KZGqIrlgurP5GU',
    name: '200h/$10200/year (legacy)',
  },
  // Yearly commitment plans (15% discount, monthly payments with 12-month commitment)
  TIER_2_17_YEARLY_COMMITMENT: {
    priceId: 'price_1RqYGaG6l1KZGqIrIzcdPzeQ',
    name: '2h/$17/month (yearly)',
  },
  TIER_6_42_YEARLY_COMMITMENT: {
    priceId: 'price_1RqYH1G6l1KZGqIrWDKh8xIU',
    name: '6h/$42.50/month (yearly)',
  },
  TIER_25_170_YEARLY_COMMITMENT: {
    priceId: 'price_1RqYHbG6l1KZGqIrAUVf8KpG',
    name: '25h/$170/month (yearly)',
  },
} as const;

function getEnvironmentMode(): EnvMode {
  const envMode = process.env.NEXT_PUBLIC_ENV_MODE.toUpperCase();
  switch (envMode) {
    case 'LOCAL':
      return EnvMode.LOCAL;
    case 'STAGING':
      return EnvMode.STAGING;
    case 'PRODUCTION':
      return EnvMode.PRODUCTION;
  //   default:
  //     if (process.env.NODE_ENV === 'development') {
  //       return EnvMode.LOCAL;
  //     } else {
  //       return EnvMode.PRODUCTION;
  //     }
  }
}

const currentEnvMode = getEnvironmentMode();

export const config: Config = {
  ENV_MODE: currentEnvMode,
  IS_LOCAL: currentEnvMode === EnvMode.LOCAL,
  IS_STAGING: currentEnvMode === EnvMode.STAGING,
  SUBSCRIPTION_TIERS:
    currentEnvMode === EnvMode.STAGING ? STAGING_TIERS : PROD_TIERS,
};

export const isLocalMode = (): boolean => {
  return config.IS_LOCAL;
};

export const isStagingMode = (): boolean => {
  return config.IS_STAGING;
};



const PROD_YEARLY_COMMITMENT_PLANS = {
  [PROD_TIERS.TIER_2_17_YEARLY_COMMITMENT.priceId]: { tier: 1, name: '2h/$17/month (yearly)' },
  [PROD_TIERS.TIER_6_42_YEARLY_COMMITMENT.priceId]: { tier: 2, name: '6h/$42.50/month (yearly)' },
  [PROD_TIERS.TIER_25_170_YEARLY_COMMITMENT.priceId]: { tier: 3, name: '25h/$170/month (yearly)' },
} as const;

const STAGING_YEARLY_COMMITMENT_PLANS = {
  [STAGING_TIERS.TIER_2_17_YEARLY_COMMITMENT.priceId]: { tier: 1, name: '2h/$17/month (yearly)' },
  [STAGING_TIERS.TIER_6_42_YEARLY_COMMITMENT.priceId]: { tier: 2, name: '6h/$42.50/month (yearly)' },
  [STAGING_TIERS.TIER_25_170_YEARLY_COMMITMENT.priceId]: { tier: 3, name: '25h/$170/month (yearly)' },
} as const;

const YEARLY_COMMITMENT_PLANS = currentEnvMode === EnvMode.STAGING 
  ? STAGING_YEARLY_COMMITMENT_PLANS 
  : PROD_YEARLY_COMMITMENT_PLANS;

// Helper functions for yearly commitment plans
export const isYearlyCommitmentPlan = (priceId: string): boolean => {
  return priceId in YEARLY_COMMITMENT_PLANS;
};

export const getYearlyCommitmentTier = (priceId: string): number => {
  return YEARLY_COMMITMENT_PLANS[priceId as keyof typeof YEARLY_COMMITMENT_PLANS]?.tier ?? 0;
};

export const isYearlyCommitmentDowngrade = (currentPriceId: string, newPriceId: string): boolean => {
  // Check if both are yearly commitment plans
  if (!isYearlyCommitmentPlan(currentPriceId) || !isYearlyCommitmentPlan(newPriceId)) {
    return false;
  }
  
  const currentTier = getYearlyCommitmentTier(currentPriceId);
  const newTier = getYearlyCommitmentTier(newPriceId);
  
  return newTier < currentTier;
};

// Plan type identification functions
export const isMonthlyPlan = (priceId: string): boolean => {
  const allTiers = config.SUBSCRIPTION_TIERS;
  const monthlyTiers = [
    allTiers.TIER_2_20, allTiers.TIER_6_50, allTiers.TIER_12_100,
    allTiers.TIER_25_200, allTiers.TIER_50_400, allTiers.TIER_125_800,
    allTiers.TIER_200_1000
  ];
  return monthlyTiers.some(tier => tier.priceId === priceId);
};

export const isYearlyPlan = (priceId: string): boolean => {
  const allTiers = config.SUBSCRIPTION_TIERS;
  const yearlyTiers = [
    allTiers.TIER_2_20_YEARLY, allTiers.TIER_6_50_YEARLY, allTiers.TIER_12_100_YEARLY,
    allTiers.TIER_25_200_YEARLY, allTiers.TIER_50_400_YEARLY, allTiers.TIER_125_800_YEARLY,
    allTiers.TIER_200_1000_YEARLY
  ];
  return yearlyTiers.some(tier => tier.priceId === priceId);
};

// Tier level mappings for all plan types
const PLAN_TIERS = {
  // Monthly plans
  [PROD_TIERS.TIER_2_20.priceId]: { tier: 1, type: 'monthly', name: '2h/$20' },
  [PROD_TIERS.TIER_6_50.priceId]: { tier: 2, type: 'monthly', name: '6h/$50' },
  [PROD_TIERS.TIER_12_100.priceId]: { tier: 3, type: 'monthly', name: '12h/$100' },
  [PROD_TIERS.TIER_25_200.priceId]: { tier: 4, type: 'monthly', name: '25h/$200' },
  [PROD_TIERS.TIER_50_400.priceId]: { tier: 5, type: 'monthly', name: '50h/$400' },
  [PROD_TIERS.TIER_125_800.priceId]: { tier: 6, type: 'monthly', name: '125h/$800' },
  [PROD_TIERS.TIER_200_1000.priceId]: { tier: 7, type: 'monthly', name: '200h/$1000' },
  
  // Yearly plans  
  [PROD_TIERS.TIER_2_20_YEARLY.priceId]: { tier: 1, type: 'yearly', name: '2h/$204/year' },
  [PROD_TIERS.TIER_6_50_YEARLY.priceId]: { tier: 2, type: 'yearly', name: '6h/$510/year' },
  [PROD_TIERS.TIER_12_100_YEARLY.priceId]: { tier: 3, type: 'yearly', name: '12h/$1020/year' },
  [PROD_TIERS.TIER_25_200_YEARLY.priceId]: { tier: 4, type: 'yearly', name: '25h/$2040/year' },
  [PROD_TIERS.TIER_50_400_YEARLY.priceId]: { tier: 5, type: 'yearly', name: '50h/$4080/year' },
  [PROD_TIERS.TIER_125_800_YEARLY.priceId]: { tier: 6, type: 'yearly', name: '125h/$8160/year' },
  [PROD_TIERS.TIER_200_1000_YEARLY.priceId]: { tier: 7, type: 'yearly', name: '200h/$10200/year' },
  
  // Yearly commitment plans
  [PROD_TIERS.TIER_2_17_YEARLY_COMMITMENT.priceId]: { tier: 1, type: 'yearly_commitment', name: '2h/$17/month' },
  [PROD_TIERS.TIER_6_42_YEARLY_COMMITMENT.priceId]: { tier: 2, type: 'yearly_commitment', name: '6h/$42.50/month' },
  [PROD_TIERS.TIER_25_170_YEARLY_COMMITMENT.priceId]: { tier: 4, type: 'yearly_commitment', name: '25h/$170/month' },

  // Staging plans
  [STAGING_TIERS.TIER_2_20.priceId]: { tier: 1, type: 'monthly', name: '2h/$20' },
  [STAGING_TIERS.TIER_6_50.priceId]: { tier: 2, type: 'monthly', name: '6h/$50' },
  [STAGING_TIERS.TIER_12_100.priceId]: { tier: 3, type: 'monthly', name: '12h/$100' },
  [STAGING_TIERS.TIER_25_200.priceId]: { tier: 4, type: 'monthly', name: '25h/$200' },
  [STAGING_TIERS.TIER_50_400.priceId]: { tier: 5, type: 'monthly', name: '50h/$400' },
  [STAGING_TIERS.TIER_125_800.priceId]: { tier: 6, type: 'monthly', name: '125h/$800' },
  [STAGING_TIERS.TIER_200_1000.priceId]: { tier: 7, type: 'monthly', name: '200h/$1000' },
  
  [STAGING_TIERS.TIER_2_20_YEARLY.priceId]: { tier: 1, type: 'yearly', name: '2h/$204/year' },
  [STAGING_TIERS.TIER_6_50_YEARLY.priceId]: { tier: 2, type: 'yearly', name: '6h/$510/year' },
  [STAGING_TIERS.TIER_12_100_YEARLY.priceId]: { tier: 3, type: 'yearly', name: '12h/$1020/year' },
  [STAGING_TIERS.TIER_25_200_YEARLY.priceId]: { tier: 4, type: 'yearly', name: '25h/$2040/year' },
  [STAGING_TIERS.TIER_50_400_YEARLY.priceId]: { tier: 5, type: 'yearly', name: '50h/$4080/year' },
  [STAGING_TIERS.TIER_125_800_YEARLY.priceId]: { tier: 6, type: 'yearly', name: '125h/$8160/year' },
  [STAGING_TIERS.TIER_200_1000_YEARLY.priceId]: { tier: 7, type: 'yearly', name: '200h/$10200/year' },
  
  [STAGING_TIERS.TIER_2_17_YEARLY_COMMITMENT.priceId]: { tier: 1, type: 'yearly_commitment', name: '2h/$17/month' },
  [STAGING_TIERS.TIER_6_42_YEARLY_COMMITMENT.priceId]: { tier: 2, type: 'yearly_commitment', name: '6h/$42.50/month' },
  [STAGING_TIERS.TIER_25_170_YEARLY_COMMITMENT.priceId]: { tier: 4, type: 'yearly_commitment', name: '25h/$170/month' },
} as const;

export const getPlanInfo = (priceId: string) => {
  return PLAN_TIERS[priceId as keyof typeof PLAN_TIERS] || { tier: 0, type: 'unknown', name: 'Unknown' };
};

// Plan change validation function
export const isPlanChangeAllowed = (currentPriceId: string, newPriceId: string): { allowed: boolean; reason?: string } => {
  const currentPlan = getPlanInfo(currentPriceId);
  const newPlan = getPlanInfo(newPriceId);

  // Allow if same plan
  if (currentPriceId === newPriceId) {
    return { allowed: true };
  }

  // Restriction 1: Don't allow downgrade from monthly to lower monthly
  if (currentPlan.type === 'monthly' && newPlan.type === 'monthly' && newPlan.tier < currentPlan.tier) {
    return { 
      allowed: false, 
      reason: 'Downgrading to a lower monthly plan is not allowed. You can only upgrade to a higher tier or switch to yearly billing.' 
    };
  }

  // Restriction 2: Don't allow downgrade from yearly commitment to monthly
  if (currentPlan.type === 'yearly_commitment' && newPlan.type === 'monthly') {
    return { 
      allowed: false, 
      reason: 'Downgrading from yearly commitment to monthly is not allowed. You can only upgrade within yearly commitment plans.' 
    };
  }

  // Restriction 2b: Don't allow downgrade within yearly commitment plans
  if (currentPlan.type === 'yearly_commitment' && newPlan.type === 'yearly_commitment' && newPlan.tier < currentPlan.tier) {
    return { 
      allowed: false, 
      reason: 'Downgrading to a lower yearly commitment plan is not allowed. You can only upgrade to higher commitment tiers.' 
    };
  }

  // Restriction 3: Only allow upgrade from monthly to yearly commitment on same level or above
  if (currentPlan.type === 'monthly' && newPlan.type === 'yearly_commitment' && newPlan.tier < currentPlan.tier) {
    return { 
      allowed: false, 
      reason: 'You can only upgrade to yearly commitment plans at the same tier level or higher.' 
    };
  }

  // Allow all other changes (upgrades, yearly to yearly, yearly commitment upgrades, etc.)
  return { allowed: true };
};

// Export subscription tier type for typing elsewhere
export type SubscriptionTier = keyof typeof PROD_TIERS;
