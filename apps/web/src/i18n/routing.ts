import { defaultLocale, locales } from './catalog.mjs';

/**
 * Locale routing shared by the middleware and its tests.
 *
 * Every page lives under `app/[locale]`. Public URLs stay unprefixed for
 * English (`/pricing`) and prefixed for an explicit language (`/de/pricing`).
 * The middleware rewrites each page request onto the segment. This module
 * holds the pure parts of that decision and must stay middleware-safe: it
 * imports the locale constants only, never a catalog loader.
 */
export type RoutingLocale = (typeof locales)[number];

export function isRoutingLocale(value: unknown): value is RoutingLocale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

function normalizeRoutingLocale(value: unknown): RoutingLocale | null {
  if (typeof value !== 'string') return null;
  if (isRoutingLocale(value)) return value;
  const base = value.toLowerCase().split(/[-_]/)[0];
  return isRoutingLocale(base) ? base : null;
}

/** Internal path of a page under the `[locale]` segment. */
export function localizedPathname(locale: RoutingLocale, pathname: string): string {
  return `/${locale}${pathname === '/' ? '' : pathname}`;
}

/**
 * Paths that are not pages and must reach Next without a locale prefix:
 * Route Handlers outside `app/[locale]`, the `next.config.ts` rewrite sources
 * (including `/blog`, the separate blog app), and the static `/docs` site in
 * `public/docs`. A new top-level Route Handler must be listed here;
 * `middleware-locale-routing.test.ts` scans `src/app` and fails when one is
 * missing.
 */
const NON_PAGE_PREFIXES = [
  '/_next/',
  '/api/',
  '/v1/',
  '/scim/',
  '/supabase/',
  '/ingest/',
  '/blog',
  '/monitoring',
  '/_betterstack',
  '/docs',
  '/mcp',
  '/markdown/',
  '/markdown-negotiation',
  '/install',
  '/download/',
  '/auth/callback',
  '/auth/mobile/callback',
];

/**
 * A chat sign-in link: `/slack/login/<token>` or `/teams/login/<token>`, whose
 * token is `<payload>.<signature>` (apps/api/src/channels/core/signed-state.ts).
 */
const CHAT_LOGIN_PAGE = /^\/(?:slack|teams)\/login\/[^/]+$/;

/**
 * A request for a file or a dotted Route Handler. A dot marks one, except in a
 * chat sign-in link. From #7566 (2026-09-24, every page moved under
 * `app/[locale]`) to 2026-10-01 those links skipped the locale rewrite, and
 * every Slack and Teams sign-in answered 404.
 */
function isFilePath(pathname: string): boolean {
  if (!pathname.includes('.')) return false;
  const [, first = '', ...rest] = pathname.split('/');
  return !CHAT_LOGIN_PAGE.test(isRoutingLocale(first) ? `/${rest.join('/')}` : pathname);
}

export function isNonPagePath(pathname: string): boolean {
  if (isFilePath(pathname)) return true; // files and dotted Route Handlers
  return NON_PAGE_PREFIXES.some((prefix) => {
    if (prefix.endsWith('/')) return pathname.startsWith(prefix);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

function decodeBase64Url(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function localeFromJwt(token: unknown): RoutingLocale | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  const json = decodeBase64Url(payload);
  if (!json) return null;
  try {
    const claims = JSON.parse(json) as { user_metadata?: { locale?: unknown } };
    return normalizeRoutingLocale(claims.user_metadata?.locale);
  } catch {
    return null;
  }
}

/**
 * The profile locale stored in the Supabase session cookie, WITHOUT verifying
 * the token.
 *
 * Use this only to pick the language of a page that is the same for every
 * visitor (static marketing HTML). It is never an identity: a forged cookie
 * can only change the language the forger sees. Protected routes use the
 * verified identity instead.
 *
 * `@supabase/ssr` stores the session JSON in `<name>` or in chunks
 * `<name>.0`, `<name>.1`, …, optionally as `base64-<base64url>`.
 */
export function unverifiedSessionLocale(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  cookieName: string,
): RoutingLocale | null {
  const whole = cookies.find((cookie) => cookie.name === cookieName)?.value;
  let raw = whole;
  if (!raw) {
    const chunks: string[] = [];
    for (let index = 0; ; index += 1) {
      const chunk = cookies.find((cookie) => cookie.name === `${cookieName}.${index}`)?.value;
      if (chunk === undefined) break;
      chunks.push(chunk);
    }
    raw = chunks.length > 0 ? chunks.join('') : undefined;
  }
  if (!raw) return null;

  let json: string | null = raw;
  if (raw.startsWith('base64-')) json = decodeBase64Url(raw.slice('base64-'.length));
  if (!json) return null;
  try {
    const session = JSON.parse(json) as {
      access_token?: unknown;
      user?: { user_metadata?: { locale?: unknown } };
    };
    return (
      normalizeRoutingLocale(session.user?.user_metadata?.locale) ??
      localeFromJwt(session.access_token)
    );
  } catch {
    return null;
  }
}

export { defaultLocale };
