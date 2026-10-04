import { APP_EDGE_HEADERS } from '../shared/edge-signature';
import { isKortixToken } from '../shared/crypto';
import { appAccessCookieName } from './access';
import { APP_AUTHORIZATION_HEADER, type AppViewerHeaders } from './public-proxy-access';
import { appFrameAncestors } from './public-proxy-status';
import { APP_VIEWER_HEADER, APP_VIEWER_TOKEN_HEADER } from './viewer';
const EDGE_HOST_HEADER = APP_EDGE_HEADERS.host;
const EDGE_TIMESTAMP_HEADER = APP_EDGE_HEADERS.timestamp;
const EDGE_SIGNATURE_HEADER = APP_EDGE_HEADERS.signature;

const KORTIX_COOKIE_NAMES = new Set([
  appAccessCookieName(false),
  appAccessCookieName(true),
  '__preview_session',
]);

/** The `Cookie` header without Kortix cookies; null when nothing is left. */
function withoutKortixCookies(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (!pair) return false;
      const name = pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('=')).trim();
      return !KORTIX_COOKIE_NAMES.has(name);
    });
  return kept.length ? kept.join('; ') : null;
}

export function appUpstreamHeaders(
  request: Request,
  providerHeaders: Record<string, string>,
  publicHost: string,
  viewer?: AppViewerHeaders | null,
): Headers {
  const headers = new Headers(request.headers);
  for (const name of [
    'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
    EDGE_HOST_HEADER, EDGE_TIMESTAMP_HEADER, EDGE_SIGNATURE_HEADER,
    // Deleted unconditionally, THEN set from what the gate resolved: a client
    // must never be able to hand the App an identity of its own choosing.
    APP_VIEWER_HEADER,
    APP_VIEWER_TOKEN_HEADER,
    // The gate's own credential header: consumed here, never forwarded.
    APP_AUTHORIZATION_HEADER,
  ]) headers.delete(name);
  // App code must never receive a Kortix credential. `Authorization` carries
  // one when a CLI, CI job, or agent calls a non-public App with a PAT,
  // session, or service-account token; that header is removed. Any other
  // `Authorization` value belongs to the App (its own API key) and passes.
  const authorization = headers.get('authorization') ?? '';
  if (/^bearer\s/i.test(authorization) && isKortixToken(authorization.slice(7).trim())) {
    headers.delete('authorization');
  }
  // Kortix cookies are the gate's, not the App's: the App access cookie and the
  // preview session cookie. Every other cookie is the App's own.
  const cookie = withoutKortixCookies(headers.get('cookie'));
  if (cookie === null) headers.delete('cookie');
  else headers.set('cookie', cookie);
  if (viewer) {
    headers.set(APP_VIEWER_HEADER, viewer.context);
    if (viewer.token) headers.set(APP_VIEWER_TOKEN_HEADER, viewer.token);
  }
  headers.set('x-kortix-app-host', publicHost);
  headers.set('x-forwarded-host', publicHost);
  headers.set('x-forwarded-proto', 'https');
  // Bun fetch transparently decodes compressed upstream bodies but preserves
  // the upstream Content-Encoding header. Request identity bytes so the public
  // client never attempts to decode an already-decoded body a second time.
  headers.set('accept-encoding', 'identity');
  for (const [name, value] of Object.entries(providerHeaders)) headers.set(name, value);
  return headers;
}

function withoutFrameAncestors(value: string): string[] {
  return value
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive));
}

/** Preserve App security policy while allowing the Kortix preview browser to frame it. */
export function appPublicResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.delete('x-frame-options');

  const enforced = withoutFrameAncestors(headers.get('content-security-policy') || '');
  headers.set('content-security-policy', [...enforced, appFrameAncestors()].join('; '));

  const reportOnlyKey = 'content-security-policy-report-only';
  const reportOnly = headers.get(reportOnlyKey);
  if (reportOnly && /frame-ancestors/i.test(reportOnly)) {
    const remaining = withoutFrameAncestors(reportOnly);
    if (remaining.length) headers.set(reportOnlyKey, remaining.join('; '));
    else headers.delete(reportOnlyKey);
  }
  return headers;
}
