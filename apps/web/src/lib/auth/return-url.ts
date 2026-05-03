// Post-auth landing → /instances (workspace picker). Lets the user
// explicitly choose which workspace to enter instead of getting silently
// dropped into whichever one happened to be active. Instance-scoped deep
// links (/instances/[id]/...) still resolve directly.
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

  return trimmedValue;
}

export { DEFAULT_AUTH_RETURN_URL };
