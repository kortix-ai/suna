import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider } = await params;
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    const validProviders = ['slack', 'discord', 'teams'];
    if (!validProviders.includes(provider)) {
      console.error(`Invalid OAuth provider: ${provider}`);
      return NextResponse.redirect(
        new URL(`/agents?${provider}_error=invalid_provider`, request.url)
      );
    }

    if (error) {
      console.error(`${provider} OAuth error:`, error);
      return NextResponse.redirect(
        new URL(`/agents?${provider}_error=${error}`, request.url)
      );
    }
    
    if (!code || !state) {
      console.error(`Missing required OAuth parameters for ${provider}`);
      return NextResponse.redirect(
        new URL(`/agents?${provider}_error=missing_parameters`, request.url)
      );
    }
    
    const backendUrl = new URL(`/api/integrations/${provider}/callback`, BACKEND_URL);
    backendUrl.searchParams.set('code', code);
    backendUrl.searchParams.set('state', state);
    
    const response = await fetch(backendUrl.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (response.redirected) {
      const backendRedirectUrl = new URL(response.url);
      const redirectParams = backendRedirectUrl.searchParams;
      const frontendRedirectUrl = new URL('/agents', request.url);
      redirectParams.forEach((value, key) => {
        frontendRedirectUrl.searchParams.set(key, value);
      });
      
      return NextResponse.redirect(frontendRedirectUrl);
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`Backend OAuth callback failed for ${provider}:`, errorText);
      return NextResponse.redirect(
        new URL(`/agents?${provider}_error=backend_error`, request.url)
      );
    }
    return NextResponse.redirect(
      new URL(`/agents?${provider}_success=true`, request.url)
    );
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    const { provider } = await params;
    return NextResponse.redirect(
      new URL(`/agents?${provider}_error=callback_failed`, request.url)
    );
  }
} 