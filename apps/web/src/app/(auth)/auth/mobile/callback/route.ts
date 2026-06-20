import { buildMobileBounceHtml } from '@/lib/auth/desktop-bounce';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function authError(request: NextRequest, message: string): NextResponse {
  const url = new URL('/auth', request.url);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url);
}

/**
 * Browser-owned PKCE callback for registration started by the native app.
 * The browser exchanges the code using its cookie-held verifier, then returns
 * the resulting session to the app through the existing state-validated deep
 * link. This path is deliberately outside the universal-link matcher.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get('state');
  const code = searchParams.get('code');

  if (searchParams.get('mobile_callback') !== '1' || !state) {
    return authError(request, 'invalid_mobile_callback');
  }
  if (!code) {
    return authError(request, searchParams.get('error') || 'missing_auth_code');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session?.access_token || !data.session.refresh_token) {
    return authError(request, error?.message || 'auth_exchange_failed');
  }

  const handoffParams = new URLSearchParams();
  handoffParams.set('mobile_callback', '1');
  handoffParams.set('state', state);
  handoffParams.set('access_token', data.session.access_token);
  handoffParams.set('refresh_token', data.session.refresh_token);
  for (const key of ['terms_accepted', 'returnUrl']) {
    const value = searchParams.get(key);
    if (value) handoffParams.set(key, value);
  }

  return new NextResponse(buildMobileBounceHtml(handoffParams), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
