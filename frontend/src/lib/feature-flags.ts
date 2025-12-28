function parseEnvBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export const featureFlags = {
  /**
   * When true, hide any mobile app download / install advertising across the web app.
   *
   * Default: true (hidden)
   * Set NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING=false to show again.
   */
  disableMobileAdvertising: parseEnvBoolean(
    process.env.NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING,
    true,
  ),
} as const;

// Helpful during development/debugging; kept out of production logs.
if (process.env.NODE_ENV !== 'production') {
  console.log('[featureFlags]', featureFlags);
}

