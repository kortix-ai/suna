export function faviconUrlForHostname(hostname: string): string {
  const clean = hostname.replace(/^www\./, '');
  return `https://www.google.com/s2/favicons?domain=${clean}&sz=128`;
}

export function faviconUrlForUrl(url: string): string | null {
  try {
    return faviconUrlForHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Resolve a full URL or bare domain (e.g. google.com) to a favicon URL. */
export function faviconUrlForValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('://')) return faviconUrlForUrl(trimmed);
  return faviconUrlForHostname(trimmed);
}
