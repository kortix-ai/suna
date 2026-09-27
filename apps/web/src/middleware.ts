import { defaultLocale, locales } from '@/i18n/catalog.mjs';
import { isNonPagePath, localizedPathname, unverifiedSessionLocale } from '@/i18n/routing';
import {
  authorizeEnvironment,
  deriveEnvironmentAccessCookie,
  ENVIRONMENT_ACCESS_COOKIE,
} from '@/lib/environment-protection';
import { legalTermsRedirectUrl } from '@/lib/legal-terms-redirect';
import { MAINTENANCE_BYPASS_COOKIE, verifyBypassToken } from '@/lib/maintenance-bypass';
import { getMaintenanceConfig } from '@/lib/maintenance-store';
import {
  AUTH_BOUNCE_COOKIE,
  AUTH_BOUNCE_MAX_AGE,
  LAST_PROJECT_COOKIE,
  parseLastProjectOwner,
  PROJECT_LANDING_PATH,
  resolveDefaultLandingPath,
  serializeAuthBounce,
} from '@/lib/onboarding/landing-destination';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { resolveMiddlewareIdentity, type MiddlewareUser } from '@/lib/supabase/middleware-identity';
import { redirectPreservingCookies } from '@/lib/supabase/redirect-preserving-session';
import { createServerClient } from '@supabase/ssr';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

type Locale = (typeof locales)[number];

// next-intl reads this request header when a surface has no `[locale]` root
// param (Server Actions, Route Handlers). See i18n/request.ts.
const NEXT_INTL_LOCALE_HEADER = 'X-NEXT-INTL-LOCALE';

// Public application surfaces that support explicit locale routing for SEO
// and unauthenticated language verification (/de/about, /sr/pricing, etc.).
const MARKETING_ROUTES = [
  '/',
  '/about',
  '/agent-computer',
  '/agents-and-skills',
  '/automations',
  '/blog',
  '/careers',
  '/channels',
  '/changelog',
  '/company-as-code',
  '/connectors',
  '/contact',
  '/design-system',
  '/developers',
  '/download',
  '/enterprise',
  '/legal',
  '/marketplace',
  '/pricing',
  '/security',
  '/self-hosted',
  '/solutions',
  '/support',
  '/use-cases',
];

// Pure marketing/promo routes that a self-host with the landing page disabled
// (KORTIX_PUBLIC_DISABLE_LANDING_PAGE) should NOT serve — they bounce to the
// app. Functional public routes (/auth, /docs, /legal, /support,
// /marketplace, /share, /download, /maintenance, …) stay reachable; only the
// marketing site itself is deactivated.
const SELF_HOST_MARKETING_ONLY = [
  '/about',
  '/agent-computer',
  '/agents-and-skills',
  '/automations',
  '/channels',
  '/self-hosted',
  '/company-as-code',
  '/careers',
  '/blog',
  '/changelog',
  '/contact',
  '/developers',
  '/enterprise',
  '/pricing',
  '/use-cases',
  '/solutions',
  '/connectors',
  '/security',
];

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/', // Homepage should be public!
  '/auth',
  '/auth/callback',
  '/logout', // Signing OUT must never require signing IN — a protected /logout would be bounced to /auth?redirect=/logout, and the sign-in would land right back here
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
  '/support', // Support hub — FAQ, contact channels, account deletion
  '/docs', // Product documentation (Fumadocs) should be public
  '/about', // About page should be public
  '/agent-computer', // Agent computer marketing page should be public
  '/agents-and-skills', // marketing page should be public
  '/automations', // marketing page should be public
  '/channels', // marketing page should be public
  '/self-hosted', // marketing page should be public
  '/company-as-code', // marketing page should be public
  '/careers', // Careers page should be public
  '/changelog', // Public release notes (sourced from GitHub Releases)
  '/blog', // Public blog (MDX posts under content/blog) should be public
  '/install',
  '/install.sh',
  '/mcp', // Public read-only MCP server and server card
  '/download', // Desktop installer redirector (per-platform latest)
  '/design-system', // Living design system / brand guidelines should be public
  '/presentation', // Legacy deck paths, now 307'd to /presentations (next.config.ts)
  '/presentations', // Deck index + every registered deck. Link-shared, noindex, no login

  '/rauch', // Rauch-style particle rendering of the Kortix symbol — public, unauthenticated
  '/contact', // Request-a-demo / contact page should be public
  '/developers', // Developer walkthrough landing page should be public
  '/countryerror', // Country restriction error page should be public
  '/enterprise', // Enterprise page should be public
  '/pricing', // Pricing page should be public
  '/use-cases', // Use cases page should be public
  '/solutions', // Solutions / persona landing pages should be public
  '/connectors', // Connector directory + per-tool pages should be public
  '/security', // Security & trust page should be public
  '/maintenance', // Maintenance page must be accessible without auth
  '/debug', // Dev-only visual harnesses (tools, connecting, error) — unlinked
  '/game-of-life', // Conway's Game of Life seeded from the Kortix logo — public, unauthenticated
  '/a1o', // "All in one" — WebGL stack-layer cube landing page, public, unauthenticated
  ...locales.flatMap((locale) =>
    MARKETING_ROUTES.map((route) => `/${locale}${route === '/' ? '' : route}`),
  ),
];

// Visual, static public canvases do not need Supabase session reads. Keep them
// reachable even when local encrypted env vars are not available.
const STATIC_PUBLIC_ROUTES = ['/game-of-life', '/rauch'];

const MARKDOWN_NEGOTIATION_ROUTES = new Set([
  '/',
  '/about',
  '/developers',
  '/enterprise',
  '/pricing',
]);

const AGENT_DISCOVERY_LINK_HEADER =
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json", ' +
  '<https://api.kortix.com/v1/openapi.json>; rel="service-desc"; type="application/json", ' +
  '</docs>; rel="service-doc"; type="text/html", ' +
  '</llms.txt>; rel="describedby"; type="text/plain"';

function supportsMarkdownNegotiation(pathname: string): boolean {
  if (MARKDOWN_NEGOTIATION_ROUTES.has(pathname)) return true;
  return (
    pathname === '/docs' ||
    pathname.startsWith('/docs/') ||
    /^\/blog\/[^/]+$/.test(pathname) ||
    /^\/use-cases\/[^/]+$/.test(pathname)
  );
}

// Desktop app (KortixDesktop UA) is a pure logged-in product surface. ONLY
// these route prefixes — plus /auth/* for sign-in — are allowed to render
// inside the desktop window. Every other route (the marketing homepage, blog,
// pricing, careers, contact, legal, help, docs, share, design-system, … which
// all live at root-level slugs) is bounced to /projects. Docs and external
// links are opened in the user's real browser by the Tauri shell, never shown
// in-app. Keep this an allowlist, not a blocklist — new marketing slugs must
// stay blocked by default.
const DESKTOP_ALLOWED_ROUTES = [
  '/projects',
  '/new',
  // `/projects/[id]/settings*` rides the `/projects` prefix; the account-scoped
  // `/settings/*` mount has no `[id]` segment, so without its own entry the
  // desktop shell bounces it to the landing door — including the post-sign-in
  // redirect to `/settings/billing`.
  '/settings',
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // These are probes for server files, not product routes. A plain response also
  // avoids rendering the translated application shell for sensitive-file probes.
  if (/^\/(?:\.env(?:[./]|$)|\.git(?:\/|$)|package\.json$|etc\/passwd$)/i.test(pathname)) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Dev and staging run behind one shared HTTP Basic credential. Read through
  // dynamic keys so the standalone container uses ECS runtime values instead of
  // build-time replacements. The gate fails closed when enabled without a secret.
  const protectionEnabled = Reflect.get(process.env, 'WEB_PROTECTION_ENABLED') as
    string | undefined;
  const protectionPassword = Reflect.get(process.env, 'WEB_PROTECTION_PASSWORD') as
    string | undefined;
  const authorization = request.headers.get('authorization');
  const accessCookie = request.cookies.get(ENVIRONMENT_ACCESS_COOKIE)?.value;
  const expectedAccessCookie =
    protectionEnabled === 'true' && protectionPassword
      ? await deriveEnvironmentAccessCookie(protectionPassword)
      : undefined;
  const protection = authorizeEnvironment({
    enabled: protectionEnabled,
    password: protectionPassword,
    authorization,
    accessCookie,
    expectedAccessCookie,
    pathname,
  });
  if (!protection.allowed) {
    const configurationError = protection.reason === 'configuration_error';
    return new NextResponse(
      configurationError ? 'Environment protection is not configured.' : 'Authentication required.',
      {
        status: configurationError ? 503 : 401,
        headers: configurationError
          ? { 'Cache-Control': 'no-store' }
          : {
              'Cache-Control': 'no-store',
              'WWW-Authenticate': 'Basic realm="Kortix test environment", charset="UTF-8"',
            },
      },
    );
  }

  // Slide the access window on every authorized request, not only on a Basic
  // challenge.
  //
  // The cookie carries maxAge 7 days and used to be re-set ONLY when
  // `protection.source === 'basic'`. Once a browser held the cookie every later
  // request authorized as `source === 'cookie'`, which skipped the renewal — so
  // the window never moved and the cookie expired exactly 7 days after the one
  // Basic challenge, mid-session. The next request then 401s. A 401 on an RSC
  // navigation is not a login prompt: Next sees a non-flight, non-2xx response
  // and converts the click into a full document load
  // (fetch-server-response.js:148) — the "clicking a menu item randomly hard
  // refreshes the page" report, on dev and staging.
  //
  // Renewing whenever the request is authorized makes it a sliding session. The
  // gate is unchanged: the value is still SHA-256 of the CURRENT password, so a
  // rotation still invalidates every outstanding cookie.
  const finalizeEnvironmentAccess = (response: NextResponse) => {
    if (
      protectionEnabled === 'true' &&
      (protection.source === 'basic' || protection.source === 'cookie') &&
      expectedAccessCookie
    ) {
      response.cookies.set(ENVIRONMENT_ACCESS_COOKIE, expectedAccessCookie, {
        // No `domain` — this is the only Domain-scoped cookie in the repo,
        // and `.kortix.com` sent it to EVERY subdomain: dev's middleware set
        // a cookie that staging, prod, and api.kortix.com all received on
        // every request too, regardless of which environment actually
        // authorized it. Omitting `domain` makes it host-only (RFC 6265
        // §5.3): scoped to whichever exact host issued it.
        httpOnly: true,
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
        sameSite: 'lax',
        secure: true,
      });
    }
    return response;
  };

  // Public HTML pages have canonical Markdown representations. Rewrite only
  // explicit Markdown requests. Browsers keep the normal HTML representation.
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    request.headers
      .get('accept')
      ?.split(',')
      .some((value) => value.trim().startsWith('text/markdown')) &&
    supportsMarkdownNegotiation(pathname)
  ) {
    const markdownUrl = request.nextUrl.clone();
    markdownUrl.pathname = '/markdown-negotiation';
    markdownUrl.search = '';
    markdownUrl.searchParams.set('path', pathname);
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-kortix-markdown-path', pathname);
    return finalizeEnvironmentAccess(
      NextResponse.rewrite(markdownUrl, {
        request: { headers: requestHeaders },
      }),
    );
  }

  // Skip middleware for static files, API routes, and telemetry endpoints.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/supabase/') || // same-origin Supabase proxy (sandbox preview) — must reach the next.config rewrite, never the auth-gate
    pathname.includes('.') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/monitoring') || // Sentry error tracking tunnel (Better Stack)
    pathname.startsWith('/_betterstack') || // Better Stack browser telemetry proxy
    // Route Handlers, next.config rewrite sources (/scim, /ingest), and the
    // static /docs site: none is a page under app/[locale], so none may be
    // rewritten onto a locale. See i18n/routing.ts.
    isNonPagePath(pathname)
  ) {
    return finalizeEnvironmentAccess(NextResponse.next());
  }

  // ── Terms of Service → public Drive file (permanent 308) ────────────────
  // The Terms document moved to an externally-owned Google Drive file. Both
  // the new stable path (`/legal/terms`) and the legacy tab query
  // (`/legal?tab=terms`), including every supported locale prefix
  // (`/de/legal/terms`, `/de/legal?tab=terms`, …), permanently redirect there
  // so existing links/bookmarks keep resolving. Privacy and imprint stay local
  // on `/legal`. This runs before auth/locale logic — the destination is an
  // external URL that needs no session. See `lib/legal-terms-redirect.ts`.
  const termsDestination = legalTermsRedirectUrl(pathname, request.nextUrl.searchParams);
  if (termsDestination) {
    return finalizeEnvironmentAccess(NextResponse.redirect(termsDestination, 308));
  }

  // ── Blocking maintenance mode ──────────────────────────────────────────
  // When maintenance level is "blocking" (Full Lockdown), redirect DASHBOARD /
  // app traffic to /maintenance — but NOT the public marketing/landing site.
  // A release lockdown should take the product surface offline while new
  // visitors can still reach kortix.com, the blog, pricing, docs, etc.
  // So we bypass the redirect for every public route (which already includes
  // /, /auth, /maintenance, marketing pages, docs, …) plus the admin panel
  // (so admins can disable the lockdown). Everything else — /projects,
  // /accounts, /invites and the other authed product routes — still gets the
  // maintenance takeover.
  const isPublicMaintenanceRoute = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/'),
  );
  const isAdminMaintenanceRoute = pathname === '/admin' || pathname.startsWith('/admin/');
  const bypassesMaintenance = isPublicMaintenanceRoute || isAdminMaintenanceRoute;

  if (!bypassesMaintenance) {
    try {
      const config = await getMaintenanceConfig();
      if (config.level === 'blocking') {
        // Platform admins can mint a signed bypass token from the maintenance
        // page (POST /api/maintenance/bypass) to keep working during a full
        // lockdown. Honor a valid, unexpired token instead of redirecting.
        const adminBypass = await verifyBypassToken(
          request.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.value,
        );
        if (!adminBypass) {
          // Preserve where the user was headed so the maintenance page can
          // send them back once the lockdown is lifted.
          const maintenanceUrl = new URL('/maintenance', request.url);
          maintenanceUrl.searchParams.set('from', pathname + (request.nextUrl.search || ''));
          return finalizeEnvironmentAccess(NextResponse.redirect(maintenanceUrl));
        }
      }
    } catch {
      // If the maintenance config is unreachable, don't block traffic
    }
  }

  // Handle Supabase verification redirects at root level
  // Supabase sometimes redirects to root (/) instead of /auth/callback
  // Detect authentication parameters and redirect to proper callback handler
  if (pathname === '/' || pathname === '') {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const token = searchParams.get('token');
    const type = searchParams.get('type');
    const error = searchParams.get('error');

    // If we have Supabase auth parameters, redirect to /auth/callback
    // Note: Mobile apps use direct deep links and bypass this route
    if (code || token || type || error) {
      const callbackUrl = new URL('/auth/callback', request.url);

      // Preserve all query parameters
      searchParams.forEach((value, key) => {
        callbackUrl.searchParams.set(key, value);
      });

      console.log('🔄 Redirecting Supabase verification from root to /auth/callback');
      return finalizeEnvironmentAccess(NextResponse.redirect(callbackUrl));
    }
  }

  // ── Desktop app: logged-in product surface only ─────────────────────────
  // The desktop shell (KortixDesktop UA) must never render marketing/docs/
  // public pages. Allow only product + auth routes; bounce everything else to
  // /projects. Runs AFTER the Supabase-at-root handling (so OAuth callbacks
  // still work) and BEFORE the locale/marketing logic (irrelevant for desktop).
  // This is the authoritative gate — it catches initial loads, SSR, and
  // Next.js client/RSC navigations alike. The Tauri shell separately opens
  // docs/external links in the user's real browser.
  if (request.headers.get('user-agent')?.includes('KortixDesktop')) {
    const isAuthPath = pathname === '/auth' || pathname.startsWith('/auth/');
    const isAllowed =
      isAuthPath ||
      DESKTOP_ALLOWED_ROUTES.some(
        (route) => pathname === route || pathname.startsWith(route + '/'),
      );
    if (!isAllowed) {
      // Into the latest project, not the list — the desktop shell has no
      // marketing surface, so this bounce IS the user's default destination.
      // The landing door, not the remembered project: this gate runs BEFORE the
      // Supabase user is fetched below, so there is no identity here to check
      // the cookie against — and an unowned cookie read is exactly the bug that
      // sent one account into another account's project. The door re-resolves.
      return finalizeEnvironmentAccess(
        NextResponse.redirect(new URL(PROJECT_LANDING_PATH, request.url)),
      );
    }
  }

  // Extract path segments
  const pathSegments = pathname.split('/').filter(Boolean);
  const firstSegment = pathSegments[0];

  // Check if first segment is a locale (e.g., /de, /it)
  if (firstSegment && locales.includes(firstSegment as Locale)) {
    const locale = firstSegment as Locale;
    const remainingPath = '/' + pathSegments.slice(1).join('/') || '/';

    // Verify remaining path is a marketing route
    const isRemainingPathMarketing = MARKETING_ROUTES.some((route) => {
      if (route === '/') {
        return remainingPath === '/' || remainingPath === '';
      }
      return remainingPath === route || remainingPath.startsWith(route + '/');
    });

    if (isRemainingPathMarketing) {
      // /de/pricing is already the internal path app/[locale]/…/pricing with
      // locale=de. Rewrite onto its normalized form (/de/ -> /de) and name the
      // locale for Server Actions. Static per-locale HTML; no identity lookup.
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-locale', locale);
      requestHeaders.set(NEXT_INTL_LOCALE_HEADER, locale);
      const target = request.nextUrl.clone();
      target.pathname = localizedPathname(locale, remainingPath);
      const response = NextResponse.rewrite(target, {
        request: { headers: requestHeaders },
      });
      // Keep the locale response header for diagnostics and cache inspection.
      // Do not persist it: language only changes permanently via profile settings.
      response.headers.set('x-locale', locale);

      return finalizeEnvironmentAccess(response);
    }
  }

  // Every unprefixed page URL is rewritten onto app/[locale]. The locale is the
  // verified profile locale when this request resolves an identity, else the
  // profile locale read (unverified) from the session cookie, else English.
  // The cookie read only picks the language of a page that is identical for
  // every visitor; it never grants anything. A path that still carries a
  // locale-looking first segment here (/de/projects) is not a localized route:
  // it rewrites under the locale (/en/de/projects) and renders not-found, as
  // it always did.
  const cookieLocale = (): Locale =>
    unverifiedSessionLocale(request.cookies.getAll(), KORTIX_SUPABASE_AUTH_COOKIE) ??
    defaultLocale;
  const rewriteToLocale = (locale: Locale, base?: NextResponse) => {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-locale', locale);
    requestHeaders.set(NEXT_INTL_LOCALE_HEADER, locale);
    const target = request.nextUrl.clone();
    target.pathname = localizedPathname(locale, pathname);
    const response = NextResponse.rewrite(target, { request: { headers: requestHeaders } });
    if (base) {
      // Carry refreshed/cleared Supabase cookies and headers set on the base.
      for (const cookie of base.cookies.getAll()) response.cookies.set(cookie);
      const link = base.headers.get('Link');
      if (link) response.headers.set('Link', link);
    }
    response.headers.set('x-locale', locale);
    return response;
  };

  if (
    STATIC_PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'))
  ) {
    return finalizeEnvironmentAccess(rewriteToLocale(cookieLocale()));
  }

  // Self-host: when the landing/marketing site is disabled
  // (KORTIX_PUBLIC_DISABLE_LANDING_PAGE — default ON for self-host), the WHOLE
  // marketing surface is deactivated: the homepage and every marketing route
  // bounce straight to the app — authenticated users to /projects, everyone
  // else to /auth. Functional public routes (/docs, /legal, /support,
  // /marketplace, /share, …) are unaffected. Read via process.env directly —
  // NEXT_PUBLIC_ vars are inlined at build time, so in Docker containers they'd
  // carry the image's placeholder value; the runtime container env
  // (KORTIX_PUBLIC_/NEXT_PUBLIC_ set at `docker run`) is what must win here,
  // same convention as the Supabase vars below.
  const disableLandingPage =
    (process.env.KORTIX_PUBLIC_DISABLE_LANDING_PAGE ||
      process.env.NEXT_PUBLIC_DISABLE_LANDING_PAGE) === 'true';
  const isMarketingContent =
    pathname === '/' ||
    SELF_HOST_MARKETING_ONLY.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    );
  const isPublicRoute = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/'),
  );

  // Identity only where it changes the response: protected routes, `/` (a
  // signed-in visitor goes to a project), and marketing pages a self-host has
  // disabled (the bounce target depends on the session). Every other public
  // page is the same for everyone: static HTML, no Supabase round trip, no
  // token refresh. The browser client refreshes its own session.
  if (isPublicRoute && pathname !== '/' && !(disableLandingPage && isMarketingContent)) {
    return finalizeEnvironmentAccess(rewriteToLocale(cookieLocale()));
  }

  // Create a single Supabase client instance that we'll reuse
  let supabaseResponse = NextResponse.next({
    request,
  });

  // Every redirect issued after the Supabase client below runs must go
  // through this (see redirect-preserving-session.ts for why): otherwise the
  // browser gets bounced while still carrying the very cookie that caused the
  // bounce — the single-use refresh token never actually gets cleared/rotated
  // on the client, so the next request just repeats the same failure.
  const redirectPreservingSession = (url: URL) =>
    redirectPreservingCookies(url, supabaseResponse.cookies);

  // IMPORTANT: NEXT_PUBLIC_ vars are inlined at build time by Next.js, so in
  // Docker containers they contain placeholder values. We MUST use runtime
  // env vars (SUPABASE_URL, SUPABASE_ANON_KEY) with fallback to NEXT_PUBLIC_.
  //
  // SUPABASE_SERVER_URL is the internal Docker network URL (e.g. http://supabase-kong:8000)
  // used for server-side auth calls. SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL is the
  // public-facing URL that the browser uses. The middleware runs server-side inside
  // the Docker container, so it needs the internal URL to reach Supabase.
  const supabaseUrl =
    process.env.SUPABASE_SERVER_URL ||
    process.env.SUPABASE_URL ||
    process.env.KORTIX_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.KORTIX_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: {
      name: KORTIX_SUPABASE_AUTH_COOKIE,
      path: '/',
      sameSite: 'lax',
      // `@supabase/ssr` never sets this itself — see the doc comment in
      // `lib/supabase/client.ts`.
      secure: process.env.NODE_ENV === 'production',
    },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // Resolve the identity ONCE and reuse it for every auth check below.
  //
  // The common path verifies the access token's ES256 signature in-process
  // (see lib/supabase/middleware-identity.ts) instead of round-tripping
  // GoTrue, so a client-side navigation no longer pays an edge -> Supabase hop
  // before its RSC payload can start. getUser() still runs for what cannot be
  // settled locally.
  //
  // IMPORTANT: Skip the lookup entirely for auth routes — the auth page
  // handles its own session client-side. Resolving here can trigger a
  // server-side token refresh that consumes the refresh token (GoTrue refresh
  // tokens are single-use). The updated cookie is set on the response, but if
  // the browser does a client-side navigation (router.push) instead of a full
  // page load, the Set-Cookie header may not be processed, leaving the browser
  // with a stale (revoked) refresh token → "Refresh Token Not Found" on the
  // next request. Local verification also shrinks that window: the fast path
  // never refreshes.
  let user: MiddlewareUser | null = null;
  let authError: Error | null = null;

  const isAuthRoute = pathname === '/auth' || pathname.startsWith('/auth/');

  if (!isAuthRoute) {
    const identity = await resolveMiddlewareIdentity(supabase.auth);
    user = identity.user;
    authError = identity.authError;
  }

  // Who is being bounced. Captured HERE, before the self-heal below can null
  // `user`: `getUser()` is allowed to hand back a user AND an error together,
  // and the self-heal drops that user on the floor a few lines down. Reading
  // after it would throw away the one identity the request still had.
  //
  // The remembered project's owner is the fallback, and it is what actually
  // carries attribution in the common failure: a rotated refresh token already
  // resolves to `user: null` before the self-heal runs, so there is no session
  // id left to read. That cookie outlives the token, and it is the same
  // browser-written value `resolveDefaultLandingPath` already trusts.
  //
  // Empty is an allowed answer. It means UNATTRIBUTED, which never demotes a
  // return URL — see `shouldDemoteReturnUrl`.
  const bounceOwnerId =
    user?.id || parseLastProjectOwner(request.cookies.get(LAST_PROJECT_COOKIE)?.value);

  // Self-heal a stale/rotated session. A refresh token that's invalid or
  // "already used" (e.g. after a redeploy or a two-tab refresh race) keeps
  // erroring on every request and dead-ends the user on /auth. Drop the Supabase
  // auth cookies (they can be chunked: name, name.0, name.1, …) so the next load
  // starts clean instead of looping on the bad token.
  if (authError) {
    const message = authError.message || '';
    const code = (authError as { code?: string }).code;
    if (
      code === 'refresh_token_already_used' ||
      code === 'refresh_token_not_found' ||
      /refresh token/i.test(message) ||
      /invalid.*(jwt|token)/i.test(message)
    ) {
      for (const { name } of request.cookies.getAll()) {
        if (
          name === KORTIX_SUPABASE_AUTH_COOKIE ||
          name.startsWith(`${KORTIX_SUPABASE_AUTH_COOKIE}.`)
        ) {
          supabaseResponse.cookies.delete(name);
        }
      }
      user = null;
    }
  }

  // The default destination is a PROJECT, not the projects list. When the
  // browser remembers which project was open last we jump straight there;
  // otherwise the id-free landing door resolves (or provisions) one behind an
  // instant paint. The cookie is browser-written, so `resolveDefaultLandingPath`
  // only accepts a well-formed project id and falls back to the door.
  const defaultLandingPath = resolveDefaultLandingPath(
    request.cookies.get(LAST_PROJECT_COOKIE)?.value,
    user?.id,
  );

  // FAST PATH: authenticated users hitting the homepage go straight to a project.
  if (pathname === '/' && user) {
    return finalizeEnvironmentAccess(
      redirectPreservingSession(new URL(defaultLandingPath, request.url)),
    );
  }

  // Desktop shell never shows the marketing homepage — bounce into the product.
  if (pathname === '/' && request.headers.get('user-agent')?.includes('KortixDesktop')) {
    return finalizeEnvironmentAccess(
      redirectPreservingSession(new URL(defaultLandingPath, request.url)),
    );
  }

  // Self-host with the landing page disabled (see disableLandingPage above).
  if (disableLandingPage) {
    if (isMarketingContent) {
      return finalizeEnvironmentAccess(
        redirectPreservingSession(new URL(user ? defaultLandingPath : '/auth', request.url)),
      );
    }
  }

  // Public routes that reach this point resolved an identity (`/`, or a
  // disabled self-host marketing page). Carry supabaseResponse's cookies into
  // the locale rewrite so a getUser() token refresh is preserved. Dropping them
  // would break the session on the next navigation.
  if (isPublicRoute) {
    if (pathname === '/') {
      supabaseResponse.headers.set('Link', AGENT_DISCOVERY_LINK_HEADER);
    }
    return finalizeEnvironmentAccess(rewriteToLocale(cookieLocale(), supabaseResponse));
  }

  // Protected routes render in the verified profile locale.
  const signedInLocale = (): Locale => {
    const profileLocale = user?.user_metadata?.locale;
    if (typeof profileLocale === 'string') {
      const base = profileLocale.toLowerCase().split(/[-_]/)[0];
      if (locales.includes(profileLocale as Locale)) return profileLocale as Locale;
      if (base && locales.includes(base as Locale)) return base as Locale;
    }
    return cookieLocale();
  };

  // Everything else requires authentication - reuse the user we already fetched
  try {
    // Redirect to auth if not authenticated (using the user we already fetched)
    if (authError || !user) {
      const url = request.nextUrl.clone();
      url.pathname = '/auth';
      const redirectTarget = `${pathname}${request.nextUrl.search || ''}`;
      url.searchParams.set('redirect', redirectTarget);
      // Must preserve the self-heal cookie-clear above — without it, the
      // browser bounces to /auth still carrying the poisoned cookie, and the
      // auth page's own client-side session check has to rediscover the same
      // invalidity from scratch before it can show a usable form.
      const bounceResponse = redirectPreservingSession(url);
      // Attach WHO was bounced. `redirect` alone says where, and the auth flows
      // downstream cannot tell an expired session returning to its own project
      // from a different account picking up the previous one's path.
      bounceResponse.cookies.set(
        AUTH_BOUNCE_COOKIE,
        serializeAuthBounce(bounceOwnerId, redirectTarget),
        {
          httpOnly: true,
          maxAge: AUTH_BOUNCE_MAX_AGE,
          path: '/',
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
        },
      );
      return finalizeEnvironmentAccess(bounceResponse);
    }

    return finalizeEnvironmentAccess(rewriteToLocale(signedInLocale(), supabaseResponse));
  } catch (error) {
    console.error('Middleware error:', error);
    return finalizeEnvironmentAccess(rewriteToLocale(signedInLocale(), supabaseResponse));
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder assets: images, media, fonts, wasm, JSON data, JS/CSS
     *   (Basic-auth-free on dev/staging, like images always were)
     * - docs (static Blume site in public/docs; Markdown negotiation for it is
     *   a next.config rewrite on the Accept header)
     * - monitoring (Sentry/Better Stack error tracking tunnel)
     * - _betterstack (Better Stack browser telemetry proxy)
     */
    '/((?!_next/static|_next/image|favicon.ico|monitoring|_betterstack|docs(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|JPEG|gif|webp|avif|ico|wasm|json|woff2?|ttf|otf|js|mjs|css|map|mp4|webm|mp3|zip)$).*)',
  ],
};
