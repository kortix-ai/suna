const MAX_URL_LENGTH = 2048;

/**
 * An absolute http(s) URL without credentials, normalized, or null. Model URLs reach a rendered
 * `href` or `src` only through this function: lang-core does not enforce zod refinements such as `.url()`.
 * `genuiToMarkdown` output is untrusted markdown: hosts render it through the same sanitizer as prose.
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
  if (url.username || url.password) return null;
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
}
