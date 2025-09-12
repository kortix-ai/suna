import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_ROUTES = [
  '/auth',
  '/auth/callback',
  '/auth/signup',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/legal',
  '/api/auth',
];

const BILLING_ROUTES = [
  '/activate-trial',
  '/subscription',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_ROUTES.some(route => pathname.startsWith(route))) {
    return NextResponse.next();
  }
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.') ||
    pathname.startsWith('/api/')
  ) {
    return NextResponse.next();
  }

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
    
    if (authError || !user) {
      const url = request.nextUrl.clone();
      url.pathname = '/auth';
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }

    const isLocalMode = process.env.NEXT_PUBLIC_ENV_MODE?.toLowerCase() === 'local'
    if (isLocalMode) {
      return supabaseResponse;
    }

    if (!BILLING_ROUTES.includes(pathname) && pathname !== '/') {
      const { data: accounts } = await supabase
        .schema('basejump')
        .from('accounts')
        .select('id')
        .eq('personal_account', true)
        .eq('primary_owner_user_id', user.id)
        .single();

      if (!accounts) {
        if (pathname === '/activate-trial') {
          return supabaseResponse;
        }
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
          // Don't redirect if already on subscription page
          if (pathname === '/subscription') {
            return supabaseResponse;
          }
          const url = request.nextUrl.clone();
          url.pathname = '/subscription';
          return NextResponse.redirect(url);
        } else {
          // Don't redirect if already on activate-trial page
          if (pathname === '/activate-trial') {
            return supabaseResponse;
          }
          const url = request.nextUrl.clone();
          url.pathname = '/activate-trial';
          return NextResponse.redirect(url);
        }
      }

      const hasTier = creditAccount.tier && creditAccount.tier !== 'none' && creditAccount.tier !== 'free';
      const hasActiveTrial = creditAccount.trial_status === 'active';
      const trialExpired = creditAccount.trial_status === 'expired' || creditAccount.trial_status === 'cancelled';
      const trialConverted = creditAccount.trial_status === 'converted';
      if (hasTier && (trialConverted || !trialExpired)) {
        return supabaseResponse;
      }

      if (!hasTier && !hasActiveTrial && !trialConverted) {
        if (hasUsedTrial || trialExpired || creditAccount.trial_status === 'cancelled') {
          // Don't redirect if already on subscription page
          if (pathname === '/subscription') {
            return supabaseResponse;
          }
          const url = request.nextUrl.clone();
          url.pathname = '/subscription';
          return NextResponse.redirect(url);
        } else {
          // Don't redirect if already on activate-trial page
          if (pathname === '/activate-trial') {
            return supabaseResponse;
          }
          const url = request.nextUrl.clone();
          url.pathname = '/activate-trial';
          return NextResponse.redirect(url);
        }
      } else if ((trialExpired || trialConverted) && !hasTier) {
        // Don't redirect if already on subscription page
        if (pathname === '/subscription') {
          return supabaseResponse;
        }
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