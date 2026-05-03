// Post-auth landing goes straight to the app. Middleware/client sandbox
// resolution will use the active instance cookie when present, or register the
// primary workspace without forcing the full workspace picker first.
const DEFAULT_AUTH_RETURN_URL = '/dashboard';

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
