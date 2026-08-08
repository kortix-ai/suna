import { expect, test } from '@playwright/test';

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const verifyOAuthProviders = process.env.E2E_OAUTH_PROVIDER_INITIATION === '1';

test.describe('17 — OAuth provider initiation', () => {
  test.skip(
    !verifyOAuthProviders,
    'Set E2E_OAUTH_PROVIDER_INITIATION=1 for the deployed OAuth gate.',
  );

  test('Google accepts the target Supabase callback URI', async ({ page }) => {
    const authUrl = new URL('/auth', frontendUrl);
    authUrl.searchParams.set('returnUrl', '/projects?kortix_use2_oauth_smoke=1');
    await page.goto(authUrl.toString());

    const authorizeResponsePromise = page.waitForResponse(
      (response) =>
        response.url().startsWith(`${supabaseUrl}/auth/v1/authorize`) &&
        response.request().method() === 'GET',
    );
    const googleRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.hostname === 'accounts.google.com' && url.pathname === '/o/oauth2/v2/auth';
    });

    await page.getByRole('button', { name: /continue with google/i }).click();

    const [authorizeResponse, googleRequest] = await Promise.all([
      authorizeResponsePromise,
      googleRequestPromise,
    ]);
    expect(authorizeResponse.status()).toBe(302);

    const authorizeUrl = new URL(authorizeResponse.url());
    expect(authorizeUrl.searchParams.get('provider')).toBe('google');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('s256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();

    const redirectTo = authorizeUrl.searchParams.get('redirect_to');
    expect(redirectTo).toBeTruthy();
    if (!redirectTo) throw new Error('OAuth authorize URL has no redirect_to');
    const frontendCallback = new URL(redirectTo);
    expect(frontendCallback.origin).toBe(frontendUrl);
    expect(frontendCallback.pathname).toBe('/auth/callback');
    expect(frontendCallback.searchParams.get('returnUrl')).toBe(
      '/projects?kortix_use2_oauth_smoke=1',
    );

    const googleUrl = new URL(googleRequest.url());
    expect(googleUrl.searchParams.get('client_id')).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(googleUrl.searchParams.get('redirect_uri')).toBe(`${supabaseUrl}/auth/v1/callback`);

    await page.waitForURL(
      (url) => url.hostname === 'accounts.google.com' && url.pathname !== '/o/oauth2/v2/auth',
      { timeout: 30_000 },
    );
    await page.waitForLoadState('domcontentloaded');

    expect(new URL(page.url()).pathname).not.toBe('/signin/oauth/error');
    await expect(page.locator('body')).not.toContainText('redirect_uri_mismatch');
  });

  test('GitHub accepts the target Supabase callback URI', async ({ page }) => {
    const frontendCallback = new URL('/auth/callback', frontendUrl);
    frontendCallback.searchParams.set('returnUrl', '/projects?kortix_use2_github_oauth_smoke=1');
    const authorizeUrl = new URL('/auth/v1/authorize', supabaseUrl);
    authorizeUrl.searchParams.set('provider', 'github');
    authorizeUrl.searchParams.set('redirect_to', frontendCallback.toString());

    const githubRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.hostname === 'github.com' && url.pathname === '/login/oauth/authorize';
    });

    const authorizeResponse = await page.goto(authorizeUrl.toString());
    const githubRequest = await githubRequestPromise;

    expect(authorizeResponse?.status()).toBe(200);
    const githubUrl = new URL(githubRequest.url());
    expect(githubUrl.searchParams.get('client_id')).toBeTruthy();
    expect(githubUrl.searchParams.get('redirect_uri')).toBe(`${supabaseUrl}/auth/v1/callback`);

    await page.waitForURL((url) => url.hostname === 'github.com', {
      timeout: 30_000,
    });
    await page.waitForLoadState('domcontentloaded');

    expect(new URL(page.url()).pathname).toBe('/login');
    await expect(page.locator('body')).not.toContainText(
      /redirect_uri|incorrect client|application suspended/i,
    );
  });
});
