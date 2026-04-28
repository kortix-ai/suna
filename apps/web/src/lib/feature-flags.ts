function parseEnvBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export const featureFlags = {
  disableMobileAdvertising: parseEnvBoolean(
    process.env.NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING,
    false,
  ),
  enableDinoGame: parseEnvBoolean(
    process.env.NEXT_PUBLIC_ENABLE_DINO_GAME,
    false,
  ),
  newLayout: parseEnvBoolean(
    process.env.NEXT_PUBLIC_FRONTEND_NEW_LAYOUT,
    false,
  ),
} as const;
