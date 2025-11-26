import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Auth Callback Route - Best Practice Implementation
 * 
 * This handles authentication callbacks for both web and mobile using:
 * 1. Explicit source parameter (most reliable)
 * 2. User-agent fallback (for backwards compatibility)
 * 3. Smart redirect page for mobile (graceful fallback if app not installed)
 */

/**
 * Detect if the request is from a mobile device (fallback only)
 * Primary detection should use the `source` query parameter
 */
function isMobileDevice(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
  return mobileRegex.test(userAgent);
}

/**
 * Generate a smart mobile redirect page
 * This provides a better UX than direct deep link redirect:
 * - Shows loading state while attempting deep link
 * - Provides fallback button if app doesn't open
 * - Works even if app isn't installed
 */
function generateMobileRedirectPage(deepLinkUrl: string, webFallbackUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Opening Kortix...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #fafafa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      text-align: center;
      max-width: 320px;
    }
    .logo {
      width: 48px;
      height: 48px;
      margin: 0 auto 24px;
    }
    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #e5e5e5;
      border-top-color: #000;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 24px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    h1 {
      font-size: 20px;
      font-weight: 500;
      color: #000;
      margin-bottom: 8px;
    }
    p {
      font-size: 14px;
      color: #666;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .button {
      display: inline-block;
      background: #000;
      color: #fff;
      font-size: 15px;
      font-weight: 500;
      padding: 14px 28px;
      border-radius: 12px;
      text-decoration: none;
      margin-bottom: 12px;
      width: 100%;
    }
    .button-secondary {
      background: transparent;
      color: #666;
      border: 1px solid #e5e5e5;
    }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://kortix.com/Logomark.svg" alt="Kortix" class="logo" />
    
    <div id="loading">
      <div class="spinner"></div>
      <h1>Opening Kortix</h1>
      <p>Redirecting you to the app...</p>
    </div>
    
    <div id="fallback" class="hidden">
      <h1>Almost there!</h1>
      <p>If the app didn't open automatically, tap the button below.</p>
      <a href="${deepLinkUrl}" class="button">Open in Kortix App</a>
      <a href="${webFallbackUrl}" class="button button-secondary">Continue in Browser</a>
    </div>
  </div>
  
  <script>
    // Attempt to open the deep link
    const deepLink = "${deepLinkUrl}";
    const startTime = Date.now();
    
    // Try to open the app
    window.location.href = deepLink;
    
    // Show fallback after 2 seconds if still on page
    setTimeout(function() {
      // If we're still here after 2s, the deep link probably didn't work
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('fallback').classList.remove('hidden');
    }, 2000);
    
    // Listen for visibility change (app opened successfully)
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        // Page hidden means app likely opened - close this tab after delay
        setTimeout(function() { window.close(); }, 500);
      }
    });
  </script>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const token = searchParams.get('token') // Supabase verification token
  const type = searchParams.get('type') // signup, recovery, etc.
  const next = searchParams.get('returnUrl') || searchParams.get('redirect') || '/dashboard'
  const termsAccepted = searchParams.get('terms_accepted') === 'true'
  
  // Source-based routing (most reliable)
  // - 'mobile' = explicitly from mobile app, redirect to deep link
  // - 'web' or undefined = web browser, stay on web
  const source = searchParams.get('source')
  const userAgent = request.headers.get('user-agent')
  
  // Determine if this is a mobile request
  // Priority: 1) explicit source param, 2) user-agent fallback
  const isMobile = source === 'mobile' || (source !== 'web' && isMobileDevice(userAgent))
  
  // Use request origin for redirects (most reliable for local dev)
  // This ensures localhost:3000 redirects stay on localhost, not staging
  const requestOrigin = request.nextUrl.origin
  const baseUrl = requestOrigin || process.env.NEXT_PUBLIC_URL || 'http://localhost:3000'
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  console.log('🔐 Auth callback:', { 
    hasCode: !!code, 
    hasToken: !!token,
    type,
    source, 
    isMobile,
    termsAccepted,
    baseUrl, // Log the resolved base URL for debugging
    requestOrigin: request.nextUrl.origin,
  });

  // Handle errors
  if (error) {
    console.error('❌ Auth callback error:', error, errorDescription)
    
    if (isMobile) {
      const deepLinkUrl = `kortix://auth/callback?error=${encodeURIComponent(error)}`
      const webFallbackUrl = `${baseUrl}/auth?error=${encodeURIComponent(error)}`
      return new NextResponse(generateMobileRedirectPage(deepLinkUrl, webFallbackUrl), {
        headers: { 'Content-Type': 'text/html' },
      })
    }
    
    return NextResponse.redirect(`${baseUrl}/auth?error=${encodeURIComponent(error)}`)
  }

  // Handle token-based verification (email confirmation, etc.)
  // Supabase sends these to the redirect URL for processing
  if (token && type) {
    // For token-based flows, we need to redirect to a page that can handle the verification
    // The token needs to be processed client-side by Supabase
    const verifyUrl = new URL(`${baseUrl}/auth`)
    verifyUrl.searchParams.set('token', token)
    verifyUrl.searchParams.set('type', type)
    if (termsAccepted) verifyUrl.searchParams.set('terms_accepted', 'true')
    
    if (isMobile) {
      // For mobile, redirect to deep link with token
      const deepLinkUrl = `kortix://auth/callback?token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}${termsAccepted ? '&terms_accepted=true' : ''}`
      return new NextResponse(generateMobileRedirectPage(deepLinkUrl, verifyUrl.toString()), {
        headers: { 'Content-Type': 'text/html' },
      })
    }
    
    return NextResponse.redirect(verifyUrl)
  }

  // Handle code exchange (OAuth, magic link)
  if (code) {
    const supabase = await createClient()
    
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)
      
      if (error) {
        console.error('❌ Error exchanging code for session:', error)
        
        if (isMobile) {
          const deepLinkUrl = `kortix://auth/callback?error=${encodeURIComponent(error.message)}`
          const webFallbackUrl = `${baseUrl}/auth?error=${encodeURIComponent(error.message)}`
          return new NextResponse(generateMobileRedirectPage(deepLinkUrl, webFallbackUrl), {
            headers: { 'Content-Type': 'text/html' },
          })
        }
        
        return NextResponse.redirect(`${baseUrl}/auth?error=${encodeURIComponent(error.message)}`)
      }

      // Determine the final destination
      let finalDestination = next

      if (data.user) {
        // Save terms acceptance date if not already saved
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

        // Check if user needs to complete setup
        const { data: accountData } = await supabase
          .schema('basejump')
          .from('accounts')
          .select('id, created_at')
          .eq('primary_owner_user_id', data.user.id)
          .eq('personal_account', true)
          .single();

        if (accountData) {
          const { data: creditAccount } = await supabase
            .from('credit_accounts')
            .select('tier, stripe_subscription_id')
            .eq('account_id', accountData.id)
            .single();

          if (creditAccount && (creditAccount.tier === 'none' || !creditAccount.stripe_subscription_id)) {
            finalDestination = '/setting-up'
          }
        }
      }

      console.log('✅ Auth successful, redirecting to:', finalDestination, 'isMobile:', isMobile)

      // Handle mobile redirect with smart page
      if (isMobile) {
        // Build deep link with session tokens for the mobile app
        const session = data.session
        if (session) {
          const deepLinkParams = new URLSearchParams({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            returnUrl: finalDestination,
          })
          if (termsAccepted) deepLinkParams.set('terms_accepted', 'true')
          
          const deepLinkUrl = `kortix://auth/callback?${deepLinkParams.toString()}`
          const webFallbackUrl = `${baseUrl}${finalDestination}`
          
          return new NextResponse(generateMobileRedirectPage(deepLinkUrl, webFallbackUrl), {
            headers: { 'Content-Type': 'text/html' },
          })
        }
      }

      // Web redirect
      return NextResponse.redirect(`${baseUrl}${finalDestination}`)
    } catch (error) {
      console.error('❌ Unexpected error in auth callback:', error)
      
      if (isMobile) {
        const deepLinkUrl = `kortix://auth/callback?error=unexpected_error`
        const webFallbackUrl = `${baseUrl}/auth?error=unexpected_error`
        return new NextResponse(generateMobileRedirectPage(deepLinkUrl, webFallbackUrl), {
          headers: { 'Content-Type': 'text/html' },
        })
      }
      
      return NextResponse.redirect(`${baseUrl}/auth?error=unexpected_error`)
    }
  }
  
  // No code or token - redirect to auth page
  if (isMobile) {
    const deepLinkUrl = `kortix://auth/callback`
    const webFallbackUrl = `${baseUrl}/auth`
    return new NextResponse(generateMobileRedirectPage(deepLinkUrl, webFallbackUrl), {
      headers: { 'Content-Type': 'text/html' },
    })
  }
  
  return NextResponse.redirect(`${baseUrl}/auth`)
}
