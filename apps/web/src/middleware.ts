import { locales, type Locale } from '@/i18n/config';
import { getMaintenanceConfig } from '@/lib/maintenance-store';
import { MAINTENANCE_BYPASS_COOKIE, verifyBypassToken } from '@/lib/maintenance-bypass';
// Route tables + their matchers live in lib/routing/route-tables so they can be
// unit-tested — the desktop allowlist especially, which is the only thing
// keeping the marketing site out of the desktop window.
import {
  MARKETING_ROUTES,
  isDesktopAllowedRoute,
  isPublicRoute,
  isSelfHostMarketingContent,
  isStaticPublicRoute,
  supportsMarkdownNegotiation,
} from '@/lib/routing/route-tables';
import { parseLastProjectCookie } from '@/lib/home/last-project-cookie';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { redirectPreservingCookies } from '@/lib/supabase/redirect-preserving-session';
import { createServerClient } from '@supabase/ssr';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const AGENT_DISCOVERY_LINK_HEADER =
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json", ' +
  '<https://api.kortix.com/v1/openapi.json>; rel="service-desc"; type="application/json", ' +
  '</docs>; rel="service-doc"; type="text/html", ' +
  '</llms.txt>; rel="describedby"; type="text/plain"';

// Routes that require authentication but are related to billing/setup
const BILLING_ROUTES: string[] = [];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
    return NextResponse.rewrite(markdownUrl, {
      request: { headers: requestHeaders },
    });
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
    pathname.startsWith('/_betterstack') // Better Stack browser telemetry proxy
  ) {
    return NextResponse.next();
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
  const isPublicMaintenanceRoute = isPublicRoute(pathname);
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
          return NextResponse.redirect(maintenanceUrl);
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
      return NextResponse.redirect(callbackUrl);
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
    if (!isDesktopAllowedRoute(pathname)) {
      return NextResponse.redirect(new URL('/projects', request.url));
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
      // Rewrite /de to /, etc.
      const response = NextResponse.rewrite(new URL(remainingPath, request.url));
      // Store locale in headers so next-intl can pick it up for the explicit URL.
      // Do not persist it: language only changes permanently via profile settings.
      response.headers.set('x-locale', locale);

      return response;
    }
  }

  // The marketing narrative moved from `/` to `/why`, so a bare locale root
  // (/de, /it) has to follow it or those pages stop ranking.
  if (pathSegments.length === 1 && locales.includes(firstSegment as Locale)) {
    return NextResponse.redirect(new URL(`/${firstSegment}/why`, request.url));
  }

  if (isStaticPublicRoute(pathname)) {
    return NextResponse.next();
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

  // Fetch user ONCE and reuse for auth checks.
  // IMPORTANT: Skip getUser() for auth routes — the auth page handles its
  // own session client-side. Calling getUser() here can trigger a server-side
  // token refresh that consumes the refresh token (GoTrue refresh tokens are
  // single-use). The updated cookie is set on the response, but if the browser
  // does a client-side navigation (router.push) instead of a full page load,
  // the Set-Cookie header may not be processed, leaving the browser with a
  // stale (revoked) refresh token → "Refresh Token Not Found" on the next request.
  let user: { id: string; user_metadata?: { locale?: string } } | null = null;
  let authError: Error | null = null;

  const isAuthRoute = pathname === '/auth' || pathname.startsWith('/auth/');

  if (!isAuthRoute) {
    try {
      const {
        data: { user: fetchedUser },
        error: fetchedError,
      } = await supabase.auth.getUser();
      user = fetchedUser;
      authError = fetchedError as Error | null;
    } catch (error) {
      // User might not be authenticated, continue
      authError = error as Error;
    }
  }

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
        if (name === KORTIX_SUPABASE_AUTH_COOKIE || name.startsWith(`${KORTIX_SUPABASE_AUTH_COOKIE}.`)) {
          supabaseResponse.cookies.delete(name);
        }
      }
      user = null;
    }
  }

  // `/` is the product now, for signed-in and signed-out visitors alike, so
  // there is nothing to bounce here. A signed-in user is resolved into their
  // last project by the route itself; a signed-out one gets the gated shell.
  //
  // FAST PATH: skip that resolution when we already know where they were.
  // Redirecting rather than rendering in place is deliberate — ProjectSwitcher
  // keys off `pathname.startsWith('/projects/')` and ProjectShell's
  // `?customize=` effect replaces to `/projects/{id}`, so a shell rendered at
  // `/` would silently navigate away.
  if (pathname === '/' && user) {
    const lastProject = parseLastProjectCookie(request.headers.get('cookie'));
    if (lastProject) {
      return redirectPreservingSession(new URL(`/projects/${lastProject}`, request.url));
    }
  }

  // Self-host: when the landing/marketing site is disabled
  // (KORTIX_PUBLIC_DISABLE_LANDING_PAGE — default ON for self-host), the WHOLE
  // marketing surface is deactivated: the homepage and every marketing route
  // bounce straight to the app — authenticated users to /projects, everyone
  // else to /auth. Functional public routes (/docs, /help, /legal, /support,
  // /marketplace, /share, …) are unaffected. Read via process.env directly —
  // NEXT_PUBLIC_ vars are inlined at build time, so in Docker containers they'd
  // carry the image's placeholder value; the runtime container env
  // (KORTIX_PUBLIC_/NEXT_PUBLIC_ set at `docker run`) is what must win here,
  // same convention as the Supabase vars below.
  const disableLandingPage =
    (process.env.KORTIX_PUBLIC_DISABLE_LANDING_PAGE || process.env.NEXT_PUBLIC_DISABLE_LANDING_PAGE) === 'true';
  if (disableLandingPage) {
    const isMarketingContent = isSelfHostMarketingContent(pathname);
    if (isMarketingContent) {
      return redirectPreservingSession(new URL(user ? '/projects' : '/auth', request.url));
    }
  }

  // Allow all public routes — but return supabaseResponse (not NextResponse.next())
  // so that any cookie updates from getUser() token refresh are preserved.
  // Returning a fresh NextResponse.next() would discard refreshed auth cookies,
  // causing the session to break on the next navigation.
  if (isPublicRoute(pathname)) {
    if (pathname === '/') {
      supabaseResponse.headers.set('Link', AGENT_DISCOVERY_LINK_HEADER);
    }
    return supabaseResponse;
  }

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
      return redirectPreservingSession(url);
    }

    // ── Billing-related routes (activate-trial, etc.) ────────────────────
    if (BILLING_ROUTES.some((route) => pathname.startsWith(route))) {
      return supabaseResponse;
    }

    return supabaseResponse;
  } catch (error) {
    console.error('Middleware error:', error);
    return supabaseResponse;
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder assets
     * - monitoring (Sentry/Better Stack error tracking tunnel)
     * - _betterstack (Better Stack browser telemetry proxy)
     */
    '/((?!_next/static|_next/image|favicon.ico|monitoring|_betterstack|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
