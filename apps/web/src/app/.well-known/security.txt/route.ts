/**
 * `/.well-known/security.txt` (RFC 9116) — the machine-readable way to find the
 * security contact this site's legal pages and support page already name. A
 * pentest (2026-10-22) flagged its absence: a researcher had to read the Terms
 * of Service to learn where to send a report.
 *
 * Served from a Route Handler rather than `public/` because `Expires` must be
 * in the future: a static file starts advisably stale the day it ships unless
 * someone remembers to regenerate it. This computes it on every request, and
 * the path is dotted, so the middleware's file/passthrough path serves it as
 * written (no locale rewrite).
 */

const SECURITY_EMAIL = 'security@kortix.com';

export const dynamic = 'force-dynamic';

function siteOrigin(request: Request): string {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'kortix.com';
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

export function GET(request: Request): Response {
  const origin = siteOrigin(request);
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const body = [
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    `Canonical: ${origin}/.well-known/security.txt`,
    `Policy: ${origin}/security`,
    'Hiring: https://kortix.com/careers',
    '',
  ].join('\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
