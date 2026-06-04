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
  let decodedValue = trimmedValue;
  try {
    decodedValue = decodeURIComponent(trimmedValue);
  } catch {
    return fallback;
  }

  if (
    !trimmedValue.startsWith('/') ||
    trimmedValue.startsWith('//') ||
    trimmedValue.includes('\\') ||
    decodedValue.startsWith('//') ||
    decodedValue.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(trimmedValue)
  ) {
    return fallback;
  }

  try {
    const resolved = new URL(trimmedValue, 'https://kortix.local');
    if (resolved.origin !== 'https://kortix.local') return fallback;
  } catch {
    return fallback;
  }

  if (LEGACY_AUTH_RETURN_PREFIXES.some((prefix) => {
    return trimmedValue === prefix || trimmedValue.startsWith(`${prefix}/`) || trimmedValue.startsWith(`${prefix}?`);
  })) {
    return fallback;
  }

  return trimmedValue;
}
