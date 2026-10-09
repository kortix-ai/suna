const MAX_URL_LENGTH = 2048;

/**
 * An absolute http(s) URL, normalized, or null. Model output reaches `href` and `src`
 * only through this function: lang-core does not enforce zod refinements such as `.url()`.
 */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
}
