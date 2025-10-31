/**
 * Environment Configuration
 * 
 * Centralized environment mode detection
 * Matches backend's EnvMode (local, staging, production)
 */

export enum EnvMode {
  LOCAL = 'local',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

/**
 * Get current environment mode
 * Checks EXPO_PUBLIC_ENV_MODE environment variable
 * Falls back to 'local' if not set (safest default for development)
 */
export function getEnvMode(): EnvMode {
  const envMode = process.env.EXPO_PUBLIC_ENV_MODE?.toLowerCase() || 'local';
  
  switch (envMode) {
    case 'production':
      return EnvMode.PRODUCTION;
    case 'staging':
      return EnvMode.STAGING;
    case 'local':
    default:
      return EnvMode.LOCAL;
  }
}

/**
 * Current environment mode
 */
export const ENV_MODE = getEnvMode();

/**
 * Environment checks
 */
export const isLocal = ENV_MODE === EnvMode.LOCAL;
export const isStaging = ENV_MODE === EnvMode.STAGING;
export const isProduction = ENV_MODE === EnvMode.PRODUCTION;

/**
 * Use staging Stripe IDs for local/staging, production IDs for production
 */
export const useProductionStripeIds = isProduction;

/**
 * Log current environment on import (for debugging)
 */
console.log(`🌍 Mobile app environment: ${ENV_MODE}`);
console.log(`💳 Using ${useProductionStripeIds ? 'PRODUCTION' : 'STAGING'} Stripe price IDs`);

