/**
 * String utility functions
 */

/**
 * Truncate a string to a maximum length with ellipsis
 * @param str - The string to truncate
 * @param maxLength - Maximum length before truncation (default: 50)
 * @returns Truncated string with '...' if it exceeds maxLength
 */
export function truncateString(str?: string, maxLength = 50): string {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Capitalize the first letter of each whitespace- or hyphen-separated word.
 * Mirrors CSS `text-transform: capitalize` as a real string transform, for
 * contexts that can't apply CSS to get there (native `<select>` triggers,
 * exported/copied text, accessible names) — e.g. turning a lowercase agent
 * slug (`harness-reflector`) into a display name (`Harness-Reflector`).
 */
export function capitalizeWords(str: string): string {
  if (!str) return str;
  return str.replace(/(^|[\s-])([a-z])/g, (_match, sep: string, ch: string) => sep + ch.toUpperCase());
}
