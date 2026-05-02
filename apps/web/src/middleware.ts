import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { detectBestLocaleFromHeaders } from '@/lib/utils/geo-detection-server';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import {
  ACTIVE_INSTANCE_COOKIE,
  buildInstancePath,
  extractInstanceRoute,
  isInstanceDetailPath,
  isInstanceScopedAppPath,
} from '@/lib/instance-routes';
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
  '/credits-explained', // Credits explained page should be public
  '/about', // About page should be public 
  '/milano', // Milano page should be public
  '/berlin', // Berlin page should be public
  '/app', // App download page should be public,
  '/install',
  '/install.sh',
  '/careers',
  '/partnerships', // Partnerships page should be public
  '/brand', // Brand guidelines should be public
  '/pricing', // Pricing page should be public
  '/tutorials', // Tutorials page should be public
  '/enterprise', // Enterprise page should be public
  '/exploration', // Exploration page should be public
  '/countryerror', // Country restriction error page should be public
  '/landing', // Three.js landing page should be public
  '/variant-2', // Landing page variant should be public
  '/home-wip', // WIP landing page draft should be public
  '/maintenance', // Maintenance page must be accessible without auth
  ...locales.flatMap(locale => MARKETING_ROUTES.map(route => `/${locale}${route === '/' ? '' : route}`)),
];

// Routes that require authentication but are related to billing/trials/setup
const BILLING_ROUTES = [
  '/activate-trial',
  '/subscription',
  '/instances',
];

// Routes that require authentication and active subscription
const PROTECTED_ROUTES = [
  '/dashboard',
  '/agents',
  '/marketplace',
  '/skills',
  '/projects',
  '/p',
  '/workspace',
  '/settings',
  // Tab-only routes (no dedicated page.tsx in earlier versions — now have one)
  '/browser',
  '/desktop',
  '/services',
  '/sessions',
  '/terminal',
  '/files',
  '/channels',
  '/connectors',
  '/tunnel',
  '/scheduled-tasks',
  '/commands',
  '/tools',
  '/configuration',
  '/deployments',
  '/changelog',
  '/admin',
  '/legacy',
  '/onboarding',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const instanceRoute = extractInstanceRoute(pathname);
  const isInstanceDetailRoute = isInstanceDetailPath(pathname);
  // Only treat as instance-scoped if the inner path is in INSTANCE_SCOPED_ROUTES.
  // Routes with dedicated files under /instances/[id]/ (like /onboarding) are NOT
  // instance-scoped — they handle their own routing via Next.js dynamic segments.
  const isInstanceScopedRoute = !!instanceRoute && !!instanceRoute.innerPath && isInstanceScopedAppPath(instanceRoute.innerPath);
  const effectivePathname = isInstanceScopedRoute ? instanceRoute.innerPath : pathname;
  const activeInstanceId = request.cookies.get(ACTIVE_INSTANCE_COOKIE)?.value || null;

  // Block access to WIP /thread/new route - redirect to dashboard
  if (pathname.includes('/thread/new')) {
    const target = activeInstanceId ? buildInstancePath(activeInstanceId, '/dashboard') : '/instances';
    return NextResponse.redirect(new URL(target, request.url));
  }
  
  // Skip middleware for static files, API routes, and telemetry endpoints
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/v1/') ||
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
      response.cookies.set('locale', locale, {
        path: '/',
        maxAge: 31536000, // 1 year
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

  // FAST PATH: Authenticated users hitting the homepage get an instant 302
  // to /dashboard. This avoids the old client-side redirect chain that caused
  // a white flash (render null → useAuth resolves → router.replace → skeleton).
  if (pathname === '/' && user) {
    const target = activeInstanceId ? buildInstancePath(activeInstanceId, '/dashboard') : '/instances';
    return NextResponse.redirect(new URL(target, request.url));
  }

  // Desktop shell never shows the marketing homepage. The Tauri window already
  // boots at /dashboard, but any internal nav back to / (logo click, history
  // back, etc.) gets bounced too. Unauthenticated users hit the existing auth
  // gate on /dashboard and land on /auth — no special-casing needed.
  if (pathname === '/' && request.headers.get('user-agent')?.includes('KortixDesktop')) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  // Auto-redirect based on geo-detection for marketing pages
  // Only redirect if:
  // 1. User is visiting a marketing route without locale prefix
  // 2. User doesn't have an explicit preference (no cookie, no user metadata)
  // 3. Detected locale is not English (default)
  if (isMarketingRoute && (!firstSegment || !locales.includes(firstSegment as Locale))) {
    // Check if user has explicit preference in cookie
    const localeCookie = request.cookies.get('locale')?.value;
    const hasExplicitPreference = !!localeCookie && locales.includes(localeCookie as Locale);
    
    // Check user metadata (if authenticated) - reuse the user we already fetched
    let userLocale: Locale | null = null;
    if (!hasExplicitPreference && user?.user_metadata?.locale && locales.includes(user.user_metadata.locale as Locale)) {
      userLocale = user.user_metadata.locale as Locale;
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
        redirectResponse.cookies.set('locale', detectedLocale, {
          path: '/',
          maxAge: 31536000, // 1 year
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

    // ── Instance-scoped routes (/instances/:id/dashboard, etc.) ──────────
    // Rewrite to the bare app route and set the active-instance cookie.
    // Works for both cloud and local mode.
    if (isInstanceScopedRoute && instanceRoute?.instanceId) {
      const rewriteUrl = request.nextUrl.clone();
      rewriteUrl.pathname = effectivePathname;
      const response = NextResponse.rewrite(rewriteUrl);
      response.cookies.set(ACTIVE_INSTANCE_COOKIE, instanceRoute.instanceId, { path: '/', sameSite: 'lax' });
      return response;
    }

    // ── Instance detail pages (/instances, /instances/:id, /instances/:id/onboarding) ──
    if (isInstanceDetailRoute || pathname === '/instances') {
      return supabaseResponse;
    }
    if (instanceRoute?.instanceId && instanceRoute.innerPath === '/onboarding') {
      supabaseResponse.cookies.set(ACTIVE_INSTANCE_COOKIE, instanceRoute.instanceId, { path: '/', sameSite: 'lax' });
      return supabaseResponse;
    }

    // ── Bare app routes (/dashboard, /files, ...) ────────────────────────
    // Redirect to the instance-scoped version if we know which instance,
    // otherwise send to /instances to pick one.
    if (isInstanceScopedAppPath(pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = activeInstanceId ? buildInstancePath(activeInstanceId, pathname) : '/instances';
      return NextResponse.redirect(url);
    }

    // ── Billing-related routes (subscription, activate-trial, etc.) ──────
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
