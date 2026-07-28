/**
 * The middleware's route tables and the matchers that read them.
 *
 * Extracted from `middleware.ts` verbatim so they can be unit-tested. The
 * desktop allowlist in particular is a real security boundary — it is the only
 * thing keeping the marketing site out of the desktop window — and it had no
 * test while it lived inline.
 *
 * Behaviour here is intentionally identical to the inline version. Anything
 * that changes what a route resolves to belongs in `middleware.ts`, not here.
 */

import { locales } from '@/i18n/config';

/** Marketing pages that support locale routing for SEO (/de, /it, …). */
export const MARKETING_ROUTES = ['/', '/legal', '/support'];

/**
 * Pure marketing/promo routes that a self-host with the landing page disabled
 * (KORTIX_PUBLIC_DISABLE_LANDING_PAGE) should NOT serve — they bounce to the
 * app. Functional public routes (/auth, /docs, /help, /legal, /support,
 * /marketplace, /share, /download, /maintenance, …) stay reachable; only the
 * marketing site itself is deactivated.
 */
export const SELF_HOST_MARKETING_ONLY = [
  '/about',
  '/careers',
  '/blog',
  '/changelog',
  '/credits-explained',
  '/contact',
  '/developers',
  '/enterprise',
  '/pricing',
  '/use-cases',
  '/solutions',
  '/compare',
  '/integrations',
  '/security',
];

/** Routes that don't require authentication. */
export const PUBLIC_ROUTES = [
  '/', // Homepage should be public!
  '/auth',
  '/auth/callback',
  '/auth/signup',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/legal',
  '/api/auth',
  '/share', // Shared content should be public
  '/marketplace', // Public read-only marketplace directory; installs still require auth
  '/secret-intake', // Agent-minted secret setup links — token-gated, MUST be openable with no login (e.g. from a Slack link)
  '/connect', // Agent-minted Pipedream Quick Connect links — token-gated, MUST be openable with no login (distinct from authed /connectors)
  '/master-login', // Master password admin login
  '/checkout', // Public checkout wrapper for Apple compliance
  '/support', // Support page should be public
  '/help', // Help center and documentation should be public
  '/docs', // Product documentation (Fumadocs) should be public
  '/credits-explained', // Credits explained page should be public
  '/about', // About page should be public
  '/careers', // Careers page should be public
  '/changelog', // Public release notes (sourced from GitHub Releases)
  '/blog', // Public blog (MDX posts under content/blog) should be public
  '/install',
  '/install.sh',
  '/mcp', // Public read-only MCP server and server card
  '/download', // Desktop installer redirector (per-platform latest)
  '/design-system', // Living design system / brand guidelines should be public
  '/review', // Review Center clickable prototype — mock data only, public so it is shareable/clickable without login
  '/presentation', // Standalone product deck (/presentation) should be public
  '/rauch', // Rauch-style particle rendering of the Kortix symbol — public, unauthenticated
  '/contact', // Request-a-demo / contact page should be public
  '/developers', // Developer walkthrough landing page should be public
  '/countryerror', // Country restriction error page should be public
  '/enterprise', // Enterprise page should be public
  '/pricing', // Pricing page should be public
  '/use-cases', // Use cases page should be public
  '/solutions', // Solutions / persona landing pages should be public
  '/compare', // Competitor comparison pages should be public
  '/integrations', // Integrations directory + per-tool pages should be public
  '/security', // Security & trust page should be public
  '/maintenance', // Maintenance page must be accessible without auth
  '/debug', // Dev-only visual harnesses (tools, connecting, error) — unlinked
  '/game-of-life', // Conway's Game of Life seeded from the Kortix logo — public, unauthenticated
  '/chat-variants', // Session-chat variant explorations — fixture data only, public so it is shareable without login
  '/voice', // Direct join page for a live voice call — token-gated, MUST load with no login
  ...locales.flatMap((locale) =>
    MARKETING_ROUTES.map((route) => `/${locale}${route === '/' ? '' : route}`),
  ),
];

/**
 * Visual, static public canvases do not need Supabase session reads. Keep them
 * reachable even when local encrypted env vars are not available.
 */
export const STATIC_PUBLIC_ROUTES = ['/game-of-life', '/rauch'];

export const MARKDOWN_NEGOTIATION_ROUTES = new Set([
  '/',
  '/about',
  '/developers',
  '/enterprise',
  '/pricing',
]);

/**
 * Desktop app (KortixDesktop UA) is a pure logged-in product surface. ONLY
 * these route prefixes — plus /auth/* for sign-in — are allowed to render
 * inside the desktop window. Every other route (the marketing homepage, blog,
 * pricing, careers, contact, legal, help, docs, share, design-system, … which
 * all live at root-level slugs) is bounced to /projects. Docs and external
 * links are opened in the user's real browser by the Tauri shell, never shown
 * in-app. Keep this an allowlist, not a blocklist — new marketing slugs must
 * stay blocked by default.
 */
export const DESKTOP_ALLOWED_ROUTES = [
  '/projects',
  '/accounts',
  '/invites',
  '/admin',
  '/setup',
  '/connectors',
  '/oauth',
  '/checkout',
  '/tunnel',
  '/github',
  '/cli',
  '/marketplace',
  '/maintenance',
  '/countryerror',
  '/debug',
];

/* ─── Matchers ──────────────────────────────────────────────────────────── */

/**
 * Exact match, or a match on the route plus a `/` boundary.
 *
 * The `/` boundary is what stops `/pricing` from matching a bare `/` entry, and
 * `/projects-evil` from matching `/projects`. Every table above is read through
 * this — do not loosen it to a bare `startsWith`.
 */
export function matchesRoutePrefix(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function matchesAnyRoutePrefix(pathname: string, routes: readonly string[]): boolean {
  return routes.some((route) => matchesRoutePrefix(pathname, route));
}

/** Whether the desktop shell is allowed to render this path. */
export function isDesktopAllowedRoute(pathname: string): boolean {
  const isAuthPath = pathname === '/auth' || pathname.startsWith('/auth/');
  return isAuthPath || matchesAnyRoutePrefix(pathname, DESKTOP_ALLOWED_ROUTES);
}

export function isPublicRoute(pathname: string): boolean {
  return matchesAnyRoutePrefix(pathname, PUBLIC_ROUTES);
}

export function isStaticPublicRoute(pathname: string): boolean {
  return matchesAnyRoutePrefix(pathname, STATIC_PUBLIC_ROUTES);
}

/** Marketing content a self-host with the landing page disabled must not serve. */
export function isSelfHostMarketingContent(pathname: string): boolean {
  return pathname === '/' || matchesAnyRoutePrefix(pathname, SELF_HOST_MARKETING_ONLY);
}

export function supportsMarkdownNegotiation(pathname: string): boolean {
  if (MARKDOWN_NEGOTIATION_ROUTES.has(pathname)) return true;
  return (
    pathname === '/docs' ||
    pathname.startsWith('/docs/') ||
    /^\/blog\/[^/]+$/.test(pathname) ||
    /^\/use-cases\/[^/]+$/.test(pathname)
  );
}
