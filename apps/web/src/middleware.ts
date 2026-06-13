import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { getCookieLocale, getUserLocale, LOCALE_COOKIE_MAX_AGE, LOCALE_COOKIE_NAME } from '@/i18n/locale';
import { detectBestLocaleFromHeaders } from '@/lib/utils/geo-detection-server';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { ACTIVE_INSTANCE_COOKIE } from '@/lib/instance-routes';
import { getMaintenanceConfig, type MaintenanceLevel } from '@/lib/maintenance-store';

// Marketing pages that support locale routing for SEO (/de, /it, etc.)
const MARKETING_ROUTES = [
  '/',
  '/legal',
  '/support',
  '/templates',
];

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/', // Homepage should be public!
  '/auth',
  '/auth/callback',
  '/auth/signup',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/legal',
  '/api/auth',
  '/share', // Shared content should be public
  '/templates', // Template pages should be public
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
  '/download', // Desktop installer redirector (per-platform latest)
  '/design-system', // Living design system / brand guidelines should be public
  '/contact', // Request-a-demo / contact page should be public
  '/developers', // Developer walkthrough landing page should be public
  '/countryerror', // Country restriction error page should be public
  '/enterprise', // Enterprise page should be public
  '/pricing', // Pricing page should be public
  '/use-cases', // Use cases page should be public
  '/maintenance', // Maintenance page must be accessible without auth
  '/debug', // Dev-only visual harnesses (tools, connecting, error) — unlinked
  ...locales.flatMap(locale => MARKETING_ROUTES.map(route => `/${locale}${route === '/' ? '' : route}`)),
];

// Routes that require authentication but are related to billing/setup
const BILLING_ROUTES: string[] = [];

// Routes that require authentication and active subscription
const PROTECTED_ROUTES = [
  '/projects',
  '/accounts',
  '/invites',
  '/admin',
];

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
  '/templates',
  '/maintenance',
  '/countryerror',
  '/debug',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip middleware for static files, API routes, and telemetry endpoints.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/supabase/') || // same-origin Supabase proxy (sandbox preview) — must reach the next.config rewrite, never the auth-gate
    pathname.includes('.') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/monitoring') ||    // Sentry error tracking tunnel (Better Stack)
    pathname.startsWith('/_betterstack')     // Better Stack browser telemetry proxy
  ) {
    return NextResponse.next();
  }

  // ── Blocking maintenance mode ──────────────────────────────────────────
  // When maintenance level is "blocking", redirect all traffic to /maintenance
  // except the maintenance page itself and the admin panel (so admins can disable it).
  const MAINTENANCE_BYPASS = ['/maintenance', '/admin', '/auth'];
  const bypassesMaintenance = MAINTENANCE_BYPASS.some(
    (route) => pathname === route || pathname.startsWith(route + '/'),
  );

  if (!bypassesMaintenance) {
    try {
      const config = await getMaintenanceConfig();
      if (config.level === 'blocking') {
        return NextResponse.redirect(new URL('/maintenance', request.url));
      }
    } catch {
      // If Edge Config is unreachable, don't block traffic
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
    const isAuthPath = pathname === '/auth' || pathname.startsWith('/auth/');
    const isAllowed =
      isAuthPath ||
      DESKTOP_ALLOWED_ROUTES.some(
        route => pathname === route || pathname.startsWith(route + '/'),
      );
    if (!isAllowed) {
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
    const isRemainingPathMarketing = MARKETING_ROUTES.some(route => {
      if (route === '/') {
        return remainingPath === '/' || remainingPath === '';
      }
      return remainingPath === route || remainingPath.startsWith(route + '/');
    });

    if (isRemainingPathMarketing) {
      // Rewrite /de to /, etc.
      const response = NextResponse.rewrite(new URL(remainingPath, request.url));
      response.cookies.set(LOCALE_COOKIE_NAME, locale, {
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: 'lax',
      });

      // Store locale in headers so next-intl can pick it up
      response.headers.set('x-locale', locale);

      return response;
    }
  }

  // Check if this is a marketing route (without locale prefix)
  const isMarketingRoute = MARKETING_ROUTES.some(route =>
    pathname === route || pathname.startsWith(route + '/')
  );

  // Create a single Supabase client instance that we'll reuse
  let supabaseResponse = NextResponse.next({
    request,
  });

  // IMPORTANT: NEXT_PUBLIC_ vars are inlined at build time by Next.js, so in
  // Docker containers they contain placeholder values. We MUST use runtime
  // env vars (SUPABASE_URL, SUPABASE_ANON_KEY) with fallback to NEXT_PUBLIC_.
  //
  // SUPABASE_SERVER_URL is the internal Docker network URL (e.g. http://supabase-kong:8000)
  // used for server-side auth calls. SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL is the
  // public-facing URL that the browser uses. The middleware runs server-side inside
  // the Docker container, so it needs the internal URL to reach Supabase.
  const supabaseUrl = process.env.SUPABASE_SERVER_URL || process.env.SUPABASE_URL || process.env.KORTIX_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.KORTIX_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
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
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Fetch user ONCE and reuse for both locale detection and auth checks.
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
      const { data: { user: fetchedUser }, error: fetchedError } = await supabase.auth.getUser();
      user = fetchedUser;
      authError = fetchedError as Error | null;
    } catch (error) {
      // User might not be authenticated, continue
      authError = error as Error;
    }
  }

  // FAST PATH: authenticated users hitting the homepage go straight to /projects.
  if (pathname === '/' && user) {
    return NextResponse.redirect(new URL('/projects', request.url));
  }

  // Desktop shell never shows the marketing homepage — bounce to /projects.
  if (pathname === '/' && request.headers.get('user-agent')?.includes('KortixDesktop')) {
    return NextResponse.redirect(new URL('/projects', request.url));
  }

  // Auto-redirect based on geo-detection for marketing pages
  // Only redirect if:
  // 1. User is visiting a marketing route without locale prefix
  // 2. User doesn't have an explicit preference (no cookie, no user metadata)
  // 3. Detected locale is not English (default)
  if (isMarketingRoute && (!firstSegment || !locales.includes(firstSegment as Locale))) {
    // Check if user has explicit preference in cookie
    const localeCookie = getCookieLocale(request.cookies.get(LOCALE_COOKIE_NAME)?.value);
    const hasExplicitPreference = !!localeCookie;

    // Check user metadata (if authenticated) - reuse the user we already fetched
    let userLocale: Locale | null = null;
    if (!hasExplicitPreference) {
      userLocale = getUserLocale(user);
    }

    // Only auto-redirect if:
    // - No explicit preference (no cookie, no user metadata)
    // - Detected locale is not English (default)
    // This prevents unnecessary redirects for English speakers and users with preferences
    if (!hasExplicitPreference && !userLocale) {
      const acceptLanguage = request.headers.get('accept-language');

      const detectedLocale = detectBestLocaleFromHeaders(acceptLanguage);

      // Only redirect if detected locale is not English (default)
      // This prevents unnecessary redirects for English speakers
      if (detectedLocale !== defaultLocale) {
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = `/${detectedLocale}${pathname === '/' ? '' : pathname}`;

        const redirectResponse = NextResponse.redirect(redirectUrl);
        // Set cookie so we don't redirect again on next visit
        redirectResponse.cookies.set(LOCALE_COOKIE_NAME, detectedLocale, {
          path: '/',
          maxAge: LOCALE_COOKIE_MAX_AGE,
          sameSite: 'lax',
        });
        return redirectResponse;
      }
    }
  }

  // Allow all public routes — but return supabaseResponse (not NextResponse.next())
  // so that any cookie updates from getUser() token refresh are preserved.
  // Returning a fresh NextResponse.next() would discard refreshed auth cookies,
  // causing the session to break on the next navigation.
  if (PUBLIC_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'))) {
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
      return NextResponse.redirect(url);
    }

    // ── Billing-related routes (activate-trial, etc.) ────────────────────
    if (BILLING_ROUTES.some(route => pathname.startsWith(route))) {
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
