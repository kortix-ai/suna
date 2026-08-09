export const ENVIRONMENT_PROTECTION_USERNAME = 'kortix';
export const ENVIRONMENT_HEALTH_PATH = '/api/health';

export interface EnvironmentProtectionInput {
  enabled: string | undefined;
  password: string | undefined;
  authorization: string | null;
  pathname: string;
}

export type EnvironmentProtectionResult =
  | { allowed: true }
  | { allowed: false; reason: 'credentials_required' | 'configuration_error' };

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function decodeBasicAuthorization(authorization: string | null): string | null {
  if (!authorization?.startsWith('Basic ')) return null;
  try {
    return atob(authorization.slice('Basic '.length));
  } catch {
    return null;
  }
}

/**
 * Protect non-production deployments with one shared HTTP Basic credential.
 * The health path stays public so the ECS target group can evaluate task health.
 */
export function authorizeEnvironment(
  input: EnvironmentProtectionInput,
): EnvironmentProtectionResult {
  if (input.pathname === ENVIRONMENT_HEALTH_PATH || input.enabled !== 'true') {
    return { allowed: true };
  }
  if (!input.password) {
    return { allowed: false, reason: 'configuration_error' };
  }

  const decoded = decodeBasicAuthorization(input.authorization);
  if (!decoded) return { allowed: false, reason: 'credentials_required' };

  const separator = decoded.indexOf(':');
  if (separator < 0) return { allowed: false, reason: 'credentials_required' };
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (
    safeEqual(username, ENVIRONMENT_PROTECTION_USERNAME) &&
    safeEqual(password, input.password)
  ) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'credentials_required' };
}
