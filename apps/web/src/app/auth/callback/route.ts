import { createClient } from '@/lib/supabase/server'
import { getServerPublicEnv } from '@/lib/public-env-server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { ACTIVE_INSTANCE_COOKIE } from '@/lib/instance-routes'
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url'
import { buildDesktopBounceHtml } from '@/lib/auth/desktop-bounce'
import { getPublicRequestOrigin } from '@/lib/request-origin'

/**
 * Auth Callback Route - Web Handler
 * 
 * Handles authentication callbacks for web browsers.
 * 
 * Flow:
 * - If app is installed: Universal Links intercept HTTPS URLs and open app directly (bypasses this)
 * - If app is NOT installed: Opens in browser → this route handles auth and redirects to dashboard
 */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const token = searchParams.get('token') // Supabase verification token
  const type = searchParams.get('type') // signup, recovery, etc.
  const next = sanitizeAuthReturnUrl(searchParams.get('returnUrl') || searchParams.get('redirect'))
  const termsAccepted = searchParams.get('terms_accepted') === 'true'
  const email = searchParams.get('email') || '' // Email passed from magic link redirect URL
  const desktop = searchParams.get('desktop') === 'true'
  const runtimeEnv = getServerPublicEnv()

  // Desktop OAuth bounce: Supabase 302'd the user's BROWSER here. Don't
  // exchange the code on the web side — bounce to `kortix://auth/callback`
  // with the same params so the OS hands the code to the desktop app, and
  // leave the browser tab on a real page so it doesn't spin forever waiting
  // for a navigation that the kortix:// scheme never produces.
  if (desktop) {
    // The deep link is built from attacker-influenced query params, so the
    // HTML is rendered by a helper that escapes both the href attribute and the
    // inline <script> payload for their respective contexts (see desktop-bounce).
    const html = buildDesktopBounceHtml(searchParams)
    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  // Use the public browser origin for redirects. Behind self-hosted reverse
  // proxies, Next may see its internal listener (for example localhost:3001)
  // as request.nextUrl.origin, which must never leak into Location headers.
  const baseUrl = getPublicRequestOrigin(request, runtimeEnv.APP_URL)
  const error = searchParams.get('error')
  const errorCode = searchParams.get('error_code')
  const errorDescription = searchParams.get('error_description')


  // Handle errors FIRST - before any Supabase operations that might affect session
  if (error) {
    console.error('Auth callback error:', error, errorCode, errorDescription)

    // Check if the error is due to expired/invalid link
    const isExpiredOrInvalid =
      errorCode === 'otp_expired' ||
      errorCode === 'expired_token' ||
      errorCode === 'token_expired' ||
      error?.toLowerCase().includes('expired') ||
      error?.toLowerCase().includes('invalid') ||
      errorDescription?.toLowerCase().includes('expired') ||
      errorDescription?.toLowerCase().includes('invalid')

    if (isExpiredOrInvalid) {
      // Redirect to auth page with expired state to show resend form
      const expiredUrl = new URL(`${baseUrl}/auth`)
      expiredUrl.searchParams.set('expired', 'true')
      if (email) expiredUrl.searchParams.set('email', email)
      if (next) expiredUrl.searchParams.set('returnUrl', next)

      return NextResponse.redirect(expiredUrl)
    }

    // For other errors, redirect to auth page with error
    return NextResponse.redirect(`${baseUrl}/auth?error=${encodeURIComponent(error)}`)
  }

  const supabase = await createClient()

  // Handle token-based verification (email confirmation, etc.)
  // Supabase sends these to the redirect URL for processing
  if (token && type) {
    // For token-based flows, redirect to auth page that can handle the verification client-side
    const verifyUrl = new URL(`${baseUrl}/auth`)
    verifyUrl.searchParams.set('token', token)
    verifyUrl.searchParams.set('type', type)
    if (termsAccepted) verifyUrl.searchParams.set('terms_accepted', 'true')
    
    return NextResponse.redirect(verifyUrl)
  }

  // Handle code exchange (OAuth, magic link)
  if (code) {
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)
      
      if (error) {
        console.error('Error exchanging code for session:', error)
        
        // Check if the error is due to expired/invalid link
        const isExpired = 
          error.message?.toLowerCase().includes('expired') ||
          error.message?.toLowerCase().includes('invalid') ||
          error.status === 400 ||
          error.code === 'expired_token' ||
          error.code === 'token_expired' ||
          error.code === 'otp_expired'
        
        if (isExpired) {
          // Redirect to auth page with expired state to show resend form
          const expiredUrl = new URL(`${baseUrl}/auth`)
          expiredUrl.searchParams.set('expired', 'true')
          if (email) expiredUrl.searchParams.set('email', email)
          if (next) expiredUrl.searchParams.set('returnUrl', next)

          return NextResponse.redirect(expiredUrl)
        }
        
        return NextResponse.redirect(`${baseUrl}/auth?error=${encodeURIComponent(error.message)}`)
      }

      let finalDestination = next
      let shouldClearReferralCookie = false
      let authEvent = 'login'
      let authMethod = 'email'

      if (data.user) {
        // Determine if this is a new user (for analytics tracking)
        const createdAt = new Date(data.user.created_at).getTime();
        const now = Date.now();
        const isNewUser = (now - createdAt) < 60000; // Created within last 60 seconds
        authEvent = isNewUser ? 'signup' : 'login';
        authMethod = data.user.app_metadata?.provider || 'email';
        
        const pendingReferralCode = request.cookies.get('pending-referral-code')?.value
        if (pendingReferralCode) {
          try {
            await supabase.auth.updateUser({
              data: {
                referral_code: pendingReferralCode
              }
            })
            shouldClearReferralCookie = true
          } catch (error) {
            console.error('Failed to add referral code to OAuth user:', error)
          }
        }

        if (termsAccepted) {
          const currentMetadata = data.user.user_metadata || {};
          if (!currentMetadata.terms_accepted_at) {
            try {
              await supabase.auth.updateUser({
                data: {
                  ...currentMetadata,
                  terms_accepted_at: new Date().toISOString(),
                },
              });
            } catch (updateError) {
              console.warn('Failed to save terms acceptance:', updateError);
            }
          }
        }

        // Check subscription status via backend API (has direct DB access)
        const backendUrl = process.env.BACKEND_URL || runtimeEnv.BACKEND_URL || '';
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token;

        const billingEnabled = runtimeEnv.BILLING_ENABLED;
        if (billingEnabled && backendUrl && accessToken) {
          try {
            const accountStateRes = await fetch(`${backendUrl}/v1/billing/account-state`, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              signal: AbortSignal.timeout(5000),
            });

            if (accountStateRes.ok) {
              const accountState = await accountStateRes.json();
              const tierKey = accountState?.subscription?.tier_key || accountState?.tier?.name || '';
              const hasSubscription = tierKey && tierKey !== 'none';

              if (!hasSubscription) {
                finalDestination = '/accounts';
              }
            }
          } catch (err) {
            console.warn('Could not check account state from backend:', err);
          }
        }
      }

      // Web redirect - include auth event params for client-side tracking
      const redirectUrl = new URL(`${baseUrl}${finalDestination}`)
      redirectUrl.searchParams.set('auth_event', authEvent)
      redirectUrl.searchParams.set('auth_method', authMethod)
      const response = NextResponse.redirect(redirectUrl)

      // Clear stale legacy instance cookie so repo-first sessions do not inherit it after login.
      response.cookies.set(ACTIVE_INSTANCE_COOKIE, '', { maxAge: 0, path: '/' })

      // Clear referral cookie if it was processed
      if (shouldClearReferralCookie) {
        response.cookies.set('pending-referral-code', '', { maxAge: 0, path: '/' })
      }

      return response
    } catch (error) {
      console.error('Unexpected error in auth callback:', error)
      return NextResponse.redirect(`${baseUrl}/auth?error=unexpected_error`)
    }
  }
  
  // No code or token - redirect to auth page
  return NextResponse.redirect(`${baseUrl}/auth`)
}
