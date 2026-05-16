// Post-auth landing goes to the projects list.
const DEFAULT_AUTH_RETURN_URL = '/projects';
const LEGACY_AUTH_RETURN_PREFIXES = [
  '/dashboard',
  '/instances',
  '/sessions',
  '/subscription',
] as const;

export function sanitizeAuthReturnUrl(
  value?: string | null,
  fallback = DEFAULT_AUTH_RETURN_URL,
): string {
  if (!value) return fallback;

  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith('/') || trimmedValue.startsWith('//')) {
    return fallback;
  }

  if (LEGACY_AUTH_RETURN_PREFIXES.some((prefix) => {
    return trimmedValue === prefix || trimmedValue.startsWith(`${prefix}/`) || trimmedValue.startsWith(`${prefix}?`);
  })) {
    return fallback;
  }

  return trimmedValue;
}

export { DEFAULT_AUTH_RETURN_URL };
