export type Environment = 'local' | 'staging' | 'prod';

/**
 * Gets the hostname from current location
 */
const getHostname = (): string => {
  return window.location.hostname;
};

/**
 * Detects the current environment based on the hostname
 */
export const getEnvironment = (): Environment => {
  const hostname = getHostname();

  console.log(
    '🔐 [Cookie Util] Detecting environment from hostname:',
    hostname,
  );

  if (hostname.includes('local')) {
    console.log('🔐 [Cookie Util] Detected: local');
    return 'local';
  }
  if (hostname.includes('staging')) {
    console.log('🔐 [Cookie Util] Detected: staging');
    return 'staging';
  }
  console.log('🔐 [Cookie Util] Detected: prod');
  return 'prod';
};

/**
 * Gets the appropriate cookie domain for the current environment
 * This ensures staging and production cookies don't interfere with each other
 */
export const getCookieDomain = (): string => {
  const hostname = getHostname();

  console.log('🔐 [Cookie Domain] Calculating domain for hostname:', hostname);

  // For local development with subdomains
  if (hostname.includes('local.enso.bot')) {
    console.log('🔐 [Cookie Domain] Local environment → .local.enso.bot');
    return '.local.enso.bot';
  }

  // Use environment-specific domains to prevent cross-contamination
  if (hostname.includes('staging')) {
    console.log('🔐 [Cookie Domain] Staging environment → .staging.enso.bot');
    return '.staging.enso.bot';
  }

  // For production, use the main domain
  console.log('🔐 [Cookie Domain] Production environment → .enso.bot');
  return '.enso.bot';
};

/**
 * Environment helper functions
 */
export const isProduction = (): boolean => getEnvironment() === 'prod';
export const isStaging = (): boolean => getEnvironment() === 'staging';
export const isLocal = (): boolean => getEnvironment() === 'local';
