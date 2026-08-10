export const ENVIRONMENT_PROTECTION_USERNAME = 'kortix';
export const ENVIRONMENT_HEALTH_PATH = '/api/health';
export const ENVIRONMENT_ACCESS_COOKIE = '__Secure-kortix_test_access';

export interface EnvironmentProtectionInput {
  enabled: string | undefined;
  password: string | undefined;
  authorization: string | null;
  accessCookie?: string;
  expectedAccessCookie?: string;
  pathname: string;
}

export type EnvironmentProtectionResult =
  | { allowed: true; source: 'disabled' | 'health' | 'cookie' | 'basic' }
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

export async function deriveEnvironmentAccessCookie(password: string): Promise<string> {
  const input = new TextEncoder().encode(`kortix-test-access:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Protect non-production deployments with one shared HTTP Basic credential.
 * The health path stays public so the ECS target group can evaluate task health.
 */
export function authorizeEnvironment(
  input: EnvironmentProtectionInput,
): EnvironmentProtectionResult {
  if (input.pathname === ENVIRONMENT_HEALTH_PATH) {
    return { allowed: true, source: 'health' };
  }
  if (input.enabled !== 'true') {
    return { allowed: true, source: 'disabled' };
  }
  if (!input.password) {
    return { allowed: false, reason: 'configuration_error' };
  }

  if (
    input.accessCookie &&
    input.expectedAccessCookie &&
    safeEqual(input.accessCookie, input.expectedAccessCookie)
  ) {
    return { allowed: true, source: 'cookie' };
  }

  const decoded = decodeBasicAuthorization(input.authorization);
  if (!decoded) return { allowed: false, reason: 'credentials_required' };

  const separator = decoded.indexOf(':');
  if (separator < 0) return { allowed: false, reason: 'credentials_required' };
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (safeEqual(username, ENVIRONMENT_PROTECTION_USERNAME) && safeEqual(password, input.password)) {
    return { allowed: true, source: 'basic' };
  }
  return { allowed: false, reason: 'credentials_required' };
}
