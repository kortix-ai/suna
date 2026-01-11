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

