type HeaderMap = {
  get(name: string): string | null;
};

type RequestLike = {
  headers: HeaderMap;
  url: string;
  nextUrl?: {
    origin?: string;
    pathname?: string;
    search?: string;
  };
};

function firstHeaderValue(value?: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}

function normalizeOrigin(value?: string | null): string | null {
  if (!value || value.startsWith('encrypted:')) return null;

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function originFromUrl(value?: string | null): string | null {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

function isExactLoopbackOrigin(origin?: string | null): boolean {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function originFromRequestHeaders(request: RequestLike): string | null {
  const hosts = [
    firstHeaderValue(request.headers.get('x-forwarded-host')),
    firstHeaderValue(request.headers.get('host')),
  ].filter((host): host is string => !!host && !/[\s/\\]/.test(host));

  const proto =
    firstHeaderValue(request.headers.get('x-forwarded-proto')) ||
    originFromUrl(request.url)?.split(':')[0] ||
    'https';

  const origins = hosts
    .map((host) => normalizeOrigin(`${proto}://${host}`))
    .filter((origin): origin is string => !!origin);

  return origins.find((origin) => !isExactLoopbackOrigin(origin)) || origins[0] || null;
}

export function getConfiguredPublicAppOrigin(): string | null {
  return normalizeOrigin(
    process.env.KORTIX_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_URL ||
      process.env.PUBLIC_URL,
  );
}

export function getPublicRequestOrigin(
  request: RequestLike,
  configuredAppUrl: string | null = getConfiguredPublicAppOrigin(),
): string {
  const headerOrigin = originFromRequestHeaders(request);
  const configuredOrigin = normalizeOrigin(configuredAppUrl);
  const requestOrigin = normalizeOrigin(request.nextUrl?.origin) || originFromUrl(request.url);

  if (headerOrigin && !isExactLoopbackOrigin(headerOrigin)) return headerOrigin;
  if (isExactLoopbackOrigin(requestOrigin) && configuredOrigin) return configuredOrigin;

  return headerOrigin || requestOrigin || configuredOrigin || 'http://localhost:3000';
}

export function getPublicRequestUrl(
  request: RequestLike,
  path: string = `${request.nextUrl?.pathname || new URL(request.url).pathname}${request.nextUrl?.search || new URL(request.url).search}`,
  configuredAppUrl?: string | null,
): URL {
  return new URL(path, getPublicRequestOrigin(request, configuredAppUrl ?? getConfiguredPublicAppOrigin()));
}
