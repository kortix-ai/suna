import { createClient } from '@/lib/supabase/server'
import { getServerPublicEnv } from '@/lib/public-env-server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { ACTIVE_INSTANCE_COOKIE } from '@/lib/instance-routes'
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url'

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
    const forwardParams = new URLSearchParams()
    for (const [k, v] of searchParams) {
      if (k !== 'desktop') forwardParams.set(k, v)
    }
    const deepLink = `kortix://auth/callback${forwardParams.toString() ? `?${forwardParams.toString()}` : ''}`
    const escaped = deepLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>Opening Kortix…</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  html,body{margin:0;height:100%;background:#0a0a0a;color:#f4f4f5;
    font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}
  .wrap{display:grid;place-items:center;height:100%;text-align:center;padding:24px;}
  h1{font-size:22px;font-weight:500;margin:0 0 10px;letter-spacing:-0.01em;}
  p{margin:0;color:#a1a1aa;font-size:13px;line-height:1.6;max-width:340px;}
  a{color:#f4f4f5;text-decoration:underline;text-underline-offset:3px;}
  .dot{width:6px;height:6px;border-radius:50%;background:currentColor;
    display:inline-block;margin:0 2px;opacity:.4;animation:pulse 1.2s infinite both;}
  .dot:nth-child(2){animation-delay:.2s;}.dot:nth-child(3){animation-delay:.4s;}
  @keyframes pulse{0%,80%,100%{opacity:.2}40%{opacity:1}}
  .dots{margin-bottom:18px;color:#52525b;}
</style></head><body>
<div class="wrap"><div>
  <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <h1>You're signed in</h1>
  <p>Opening Kortix… you can close this tab.<br/>
    If nothing happens, <a href="${escaped}">click here</a> to open the app.</p>
</div></div>
<script>window.location.replace(${JSON.stringify(deepLink)});</script>
</body></html>`
    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  // Use request origin for redirects (most reliable for local dev)
  // This ensures localhost:3000 redirects stay on localhost, not staging
  const requestOrigin = request.nextUrl.origin
  const baseUrl = requestOrigin || runtimeEnv.APP_URL || 'http://localhost:3000'
  const error = searchParams.get('error')
  const errorCode = searchParams.get('error_code')
  const errorDescription = searchParams.get('error_description')


  // Handle errors FIRST - before any Supabase operations that might affect session
  if (error) {
    console.error('❌ Auth callback error:', error, errorCode, errorDescription)

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

      console.log('🔄 Redirecting to auth page with expired state')
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
        console.error('❌ Error exchanging code for session:', error)
        
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

          console.log('🔄 Redirecting to auth page with expired state')
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
            console.log('✅ Added referral code to OAuth user:', pendingReferralCode)
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
              console.log('✅ Terms acceptance date saved to user metadata');
            } catch (updateError) {
              console.warn('⚠️ Failed to save terms acceptance:', updateError);
            }
          }
        }

        // Check subscription status via backend API (has direct DB access)
        const backendUrl = process.env.BACKEND_URL || runtimeEnv.BACKEND_URL || '';
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token;

        const billingEnabled = runtimeEnv.ENV_MODE === 'cloud';
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
                console.log('⚠️ No subscription detected - redirecting to /subscription to choose a plan');
                finalDestination = '/subscription';
              } else {
                console.log('✅ Account already has subscription, proceeding normally');
              }
            }
          } catch (err) {
            console.warn('⚠️ Could not check account state from backend:', err);
          }
        }
      }

      // Web redirect - include auth event params for client-side tracking
      const redirectUrl = new URL(`${baseUrl}${finalDestination}`)
      redirectUrl.searchParams.set('auth_event', authEvent)
      redirectUrl.searchParams.set('auth_method', authMethod)
      const response = NextResponse.redirect(redirectUrl)

      // Clear stale instance cookie so user picks a fresh instance after login
      response.cookies.set(ACTIVE_INSTANCE_COOKIE, '', { maxAge: 0, path: '/' })

      // Clear referral cookie if it was processed
      if (shouldClearReferralCookie) {
        response.cookies.set('pending-referral-code', '', { maxAge: 0, path: '/' })
      }

      return response
    } catch (error) {
      console.error('❌ Unexpected error in auth callback:', error)
      return NextResponse.redirect(`${baseUrl}/auth?error=unexpected_error`)
    }
  }
  
  // No code or token - redirect to auth page
  return NextResponse.redirect(`${baseUrl}/auth`)
}
