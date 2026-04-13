const DEFAULT_AUTH_RETURN_URL = '/instances';

export function sanitizeAuthReturnUrl(
  value?: string | null,
  fallback = DEFAULT_AUTH_RETURN_URL,
): string {
  if (!value) return fallback;

  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith('/') || trimmedValue.startsWith('//')) {
    return fallback;
  }

  if (/^\/instances\/[^/?#]+(?:[/?#]|$)/.test(trimmedValue)) {
    return '/instances';
  }

  return trimmedValue;
}

export { DEFAULT_AUTH_RETURN_URL };
