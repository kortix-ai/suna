const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function normalizeForwardedHeader(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first || null;
}

export function getRequestUrl(req: Request, fallbackPort?: number): URL {
  if (ABSOLUTE_URL_PATTERN.test(req.url)) {
    return new URL(req.url);
  }

  const protocol = normalizeForwardedHeader(req.headers.get('x-forwarded-proto')) || 'http';
  const host = normalizeForwardedHeader(req.headers.get('x-forwarded-host'))
    || req.headers.get('host')
    || `localhost:${fallbackPort ?? 80}`;

  const pathname = req.url.startsWith('/') ? req.url : `/${req.url}`;
  return new URL(pathname, `${protocol}://${host}`);
}
