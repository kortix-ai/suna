import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { locales, defaultLocale, type Locale } from '@/i18n/config';
import { detectBestLocaleFromHeaders } from '@/lib/utils/geo-detection-server';

// Marketing pages that support locale routing for SEO (/de, /it, etc.)
const MARKETING_ROUTES = [
  '/',
  '/suna',
  '/enterprise',
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
  '/enterprise', // Enterprise page should be public
  '/master-login', // Master password admin login
  '/checkout', // Public checkout wrapper for Apple compliance
  '/support', // Support page should be public
  '/suna', // Suna rebrand page should be public for SEO
  '/model-pricing', // Model pricing page should be public
  // Add locale routes for marketing pages
  ...locales.flatMap(locale => MARKETING_ROUTES.map(route => `/${locale}${route === '/' ? '' : route}`)),
];

// Routes that require authentication but are related to billing/trials/setup
const BILLING_ROUTES = [
  '/activate-trial',
  '/subscription',
  '/setting-up',
];

// Routes that require authentication and active subscription
const PROTECTED_ROUTES = [
  '/dashboard',
  '/agents',
  '/projects',
  '/settings',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Skip middleware for static files and API routes
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.') ||
    pathname.startsWith('/api/')
  ) {
    return NextResponse.next();
  }

  // Extract path segments
  const pathSegments = pathname.split('/').filter(Boolean);
  const firstSegment = pathSegments[0];
  
  // Check if first segment is a locale (e.g., /de, /it, /de/suna)
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
      // Rewrite /de to /, /de/suna to /suna, etc.
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

  // Auto-redirect based on geo-detection for marketing pages
  // Only redirect if:
  // 1. User is visiting a marketing route without locale prefix
  // 2. User doesn't have an explicit preference (no cookie, no user metadata)
  // 3. Detected locale is not English (default)
  if (isMarketingRoute && (!firstSegment || !locales.includes(firstSegment as Locale))) {
    // Check if user has explicit preference in cookie
    const localeCookie = request.cookies.get('locale')?.value;
    const hasExplicitPreference = !!localeCookie && locales.includes(localeCookie as Locale);
    
    // Check user metadata (if authenticated) - only if no cookie preference
    let userLocale: Locale | null = null;
    if (!hasExplicitPreference) {
      try {
        const supabase = createServerClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          {
            cookies: {
              getAll() {
                return request.cookies.getAll();
              },
              setAll() {
                // No-op for middleware
              },
            },
          }
        );
        
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.user_metadata?.locale && locales.includes(user.user_metadata.locale as Locale)) {
          userLocale = user.user_metadata.locale as Locale;
        }
      } catch (error) {
        // User might not be authenticated, continue with geo-detection
      }
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

  // Allow all public routes without any checks
  if (PUBLIC_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'))) {
    return NextResponse.next();
  }

  // Everything else requires authentication
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    // Redirect to auth if not authenticated
    if (authError || !user) {
      const url = request.nextUrl.clone();
      url.pathname = '/auth';
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }

    // Skip billing checks in local mode
    const isLocalMode = process.env.NEXT_PUBLIC_ENV_MODE?.toLowerCase() === 'local'
    if (isLocalMode) {
      return supabaseResponse;
    }

    // Skip billing checks for billing-related routes
    if (BILLING_ROUTES.some(route => pathname.startsWith(route))) {
      return supabaseResponse;
    }

    // Only check billing for protected routes that require active subscription
    // NOTE: Middleware is server-side code, so direct Supabase queries are acceptable here
    // for performance reasons. Only client-side (browser) code should use backend API.
    if (PROTECTED_ROUTES.some(route => pathname.startsWith(route))) {
      const { data: accounts } = await supabase
        .schema('basejump')
        .from('accounts')
        .select('id')
        .eq('personal_account', true)
        .eq('primary_owner_user_id', user.id)
        .single();

      if (!accounts) {
        const url = request.nextUrl.clone();
        url.pathname = '/activate-trial';
        return NextResponse.redirect(url);
      }

      const accountId = accounts.id;
      const { data: creditAccount } = await supabase
        .from('credit_accounts')
        .select('tier, trial_status, trial_ends_at')
        .eq('account_id', accountId)
        .single();

      const { data: trialHistory } = await supabase
        .from('trial_history')
        .select('id')
        .eq('account_id', accountId)
        .single();

      const hasUsedTrial = !!trialHistory;

      if (!creditAccount) {
        if (hasUsedTrial) {
          const url = request.nextUrl.clone();
          url.pathname = '/subscription';
          return NextResponse.redirect(url);
        } else {
          const url = request.nextUrl.clone();
          url.pathname = '/activate-trial';
          return NextResponse.redirect(url);
        }
      }

      const hasPaidTier = creditAccount.tier && creditAccount.tier !== 'none' && creditAccount.tier !== 'free';
      const hasFreeTier = creditAccount.tier === 'free';
      const hasActiveTrial = creditAccount.trial_status === 'active';
      const trialExpired = creditAccount.trial_status === 'expired' || creditAccount.trial_status === 'cancelled';
      const trialConverted = creditAccount.trial_status === 'converted';
      
      if (hasPaidTier || hasFreeTier) {
        return supabaseResponse;
      }

      if (!hasPaidTier && !hasFreeTier && !hasActiveTrial && !trialConverted) {
        const url = request.nextUrl.clone();
        url.pathname = '/subscription';
        return NextResponse.redirect(url);
      } else if ((trialExpired || trialConverted) && !hasPaidTier && !hasFreeTier) {
        const url = request.nextUrl.clone();
        url.pathname = '/subscription';
        return NextResponse.redirect(url);
      }
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
     * - public folder
     * - root path (/)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}; 