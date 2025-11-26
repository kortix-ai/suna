import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Detect if the request is from a mobile device
 */
function isMobileDevice(userAgent: string | null): boolean {
  if (!userAgent) return false;
  
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
  return mobileRegex.test(userAgent);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('returnUrl') || searchParams.get('redirect') || '/dashboard'
  const termsAccepted = searchParams.get('terms_accepted') === 'true'
  
  // Use configured URL instead of parsed origin to avoid 0.0.0.0 issues in self-hosted environments
  const baseUrl = process.env.NEXT_PUBLIC_URL || 'http://localhost:3000'
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')
  const userAgent = request.headers.get('user-agent')

  if (error) {
    console.error('❌ Auth callback error:', error, errorDescription)
    
    // If mobile, redirect to deep link with error
    if (isMobileDevice(userAgent)) {
      return NextResponse.redirect(`kortix://auth/callback?error=${encodeURIComponent(error)}`)
    }
    
    return NextResponse.redirect(`${baseUrl}/auth?error=${encodeURIComponent(error)}`)
  }

  if (code) {
    const supabase = await createClient()
    
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)
      
      if (error) {
        console.error('❌ Error exchanging code for session:', error)
        
        // If mobile, redirect to deep link with error
        if (isMobileDevice(userAgent)) {
          return NextResponse.redirect(`kortix://auth/callback?error=${encodeURIComponent(error.message)}`)
        }
        
        return NextResponse.redirect(`${baseUrl}/auth?error=${encodeURIComponent(error.message)}`)
      }

      if (data.user) {
        // Save terms acceptance date if terms were accepted and not already saved (first time only)
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

        // Welcome email is now sent automatically by Supabase database trigger
        // See: backend/supabase/migrations/20251113000000_welcome_email_webhook.sql

        // NOTE: This is server-side route handler, so direct Supabase queries are acceptable
        // for performance. Only client-side (browser) code should use backend API.
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
            // If mobile, redirect to deep link
            if (isMobileDevice(userAgent)) {
              return NextResponse.redirect(`kortix://auth/callback?returnUrl=${encodeURIComponent('/setting-up')}`)
            }
            return NextResponse.redirect(`${baseUrl}/setting-up`);
          }
        }
      }

      // If mobile device, redirect to deep link
      if (isMobileDevice(userAgent)) {
        const deepLinkUrl = `kortix://auth/callback?returnUrl=${encodeURIComponent(next)}`
        console.log('📱 Redirecting mobile user to:', deepLinkUrl)
        return NextResponse.redirect(deepLinkUrl)
      }

      // Web: URL to redirect to after sign in process completes
      return NextResponse.redirect(`${baseUrl}${next}`)
    } catch (error) {
      console.error('❌ Unexpected error in auth callback:', error)
      
      // If mobile, redirect to deep link with error
      if (isMobileDevice(userAgent)) {
        return NextResponse.redirect(`kortix://auth/callback?error=unexpected_error`)
      }
      
      return NextResponse.redirect(`${baseUrl}/auth?error=unexpected_error`)
    }
  }
  
  // If mobile, redirect to deep link
  if (isMobileDevice(userAgent)) {
    return NextResponse.redirect(`kortix://auth/callback`)
  }
  
  return NextResponse.redirect(`${baseUrl}/auth`)
}
