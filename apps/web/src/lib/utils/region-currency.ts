/**
 * Timezone helpers for region-specific currency display hints.
 *
 * These utilities must never select the UI language. The app defaults to
 * English unless the authenticated user's profile metadata has an explicit
 * locale set from profile settings.
 */

/**
 * EU member states (27 countries)
 */
export const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/**
 * Map of EU timezones for currency display.
 */
export const EU_TIMEZONES = new Set([
  'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Madrid',
  'Europe/Vienna', 'Europe/Brussels', 'Europe/Amsterdam',
  'Europe/Copenhagen', 'Europe/Stockholm', 'Europe/Helsinki',
  'Europe/Warsaw', 'Europe/Prague', 'Europe/Budapest',
  'Europe/Bucharest', 'Europe/Athens', 'Europe/Lisbon',
  'Europe/Dublin', 'Europe/Luxembourg', 'Europe/Zagreb',
  'Europe/Sofia', 'Europe/Tallinn', 'Europe/Vilnius',
  'Europe/Riga', 'Europe/Bratislava', 'Europe/Ljubljana',
  'Europe/Malta', 'Europe/Nicosia', 'Europe/Valletta',
]);

/**
 * Detect if user is in the EU based on timezone.
 * This is a display-only heuristic and does not affect language.
 */
export function isEUTimezone(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return EU_TIMEZONES.has(timezone);
  } catch {
    return false;
  }
}

/**
 * Detect user's display currency based on timezone.
 * Returns 'EUR' for EU timezones, 'USD' otherwise.
 */
export function detectCurrencyFromTimezone(): 'USD' | 'EUR' {
  return isEUTimezone() ? 'EUR' : 'USD';
}
