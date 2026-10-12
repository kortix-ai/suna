import { expect, test, type APIRequestContext } from '@playwright/test';

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const verifyOAuthProviders = process.env.E2E_OAUTH_PROVIDER_INITIATION === '1';

/**
 * QUARANTINED — runs in `tests-browser-nightly.yml`, not in the release gate.
 *
 * This is the only browser journey whose assertions depend on servers Kortix
 * does not operate: it clicks through to `accounts.google.com` and
 * `github.com` and asserts what those pages do. Three consequences make it
 * unfit for a blocking gate, and none of them are fixable from this repo:
 *
 *  1. It failed in every observed release run — 32240074477 and 32231251280 —
 *     at 2.2 min and 32 s, on `page.waitForURL`/`waitForRequest` against a
 *     third-party redirect chain. Google and GitHub are free to add an interstitial,
 *     a consent screen, or a bot check at any time, and each of those turns the
 *     production release gate red with no Kortix defect behind it.
 *  2. It is the slowest pair in the lane. Two tests spend up to 30 s each in
 *     `waitForURL` plus a full third-party page load.
 *  3. `playwright.config.ts` puts `x-vercel-protection-bypass` in
 *     `extraHTTPHeaders`, which applies to EVERY origin the page touches — so
 *     this spec is also the one journey that sends the staging bypass secret to
 *     Google and GitHub.
 *
 * What it protects is still worth running: that Supabase's authorize endpoint
 * hands the provider the callback URI the provider has registered — the
 * `redirect_uri_mismatch` class of outage. That check just belongs on a
 * schedule with an owner, not between a release and production.
 */
test.describe('17 — OAuth provider initiation', { tag: '@quarantine' }, () => {
  test.skip(
    !verifyOAuthProviders,
    'Set E2E_OAUTH_PROVIDER_INITIATION=1 for the deployed OAuth gate.',
  );

  // The contract is what Supabase's authorize endpoint hands the provider: a 302
  // whose `Location` carries the callback URI the provider has registered. The
  // spec reads that header and never navigates to the provider. Browsing to
  // accounts.google.com / github.com tested the provider's own pages (a bot
  // check on a datacenter IP hung the Google navigation for 120 s) and sent the
  // staging bypass header to them.
  function authorizeUrlFor(provider: 'google' | 'github', frontendCallback: URL) {
    const authorizeUrl = new URL('/auth/v1/authorize', supabaseUrl);
    authorizeUrl.searchParams.set('provider', provider);
    authorizeUrl.searchParams.set('redirect_to', frontendCallback.toString());
    authorizeUrl.searchParams.set('code_challenge', 'e2e'.padEnd(43, 'x'));
    authorizeUrl.searchParams.set('code_challenge_method', 's256');
    return authorizeUrl.toString();
  }

  test('Google accepts the target Supabase callback URI', async ({ page, request }) => {
    const authUrl = new URL('/auth', frontendUrl);
    authUrl.searchParams.set('returnUrl', '/projects?kortix_use2_oauth_smoke=1');
    await page.route(/^https:\/\/accounts\.google\.com\//, (route) => route.abort());
    await page.goto(authUrl.toString());

    const authorizeRequestPromise = page.waitForRequest(
      (req) =>
        req.url().startsWith(`${supabaseUrl}/auth/v1/authorize`) && req.method() === 'GET',
    );
    await page.getByRole('button', { name: /continue with google/i }).click();
    const authorizeUrl = new URL((await authorizeRequestPromise).url());

    // What the page sent to Supabase.
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

    // What Supabase handed Google.
    const authorize = await request.get(authorizeUrlFor('google', frontendCallback), {
      maxRedirects: 0,
    });
    expect(authorize.status()).toBe(302);
    const googleUrl = new URL(authorize.headers().location ?? '');
    expect(googleUrl.hostname).toBe('accounts.google.com');
    expect(googleUrl.pathname).toBe('/o/oauth2/v2/auth');
    expect(googleUrl.searchParams.get('client_id')).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(googleUrl.searchParams.get('redirect_uri')).toBe(`${supabaseUrl}/auth/v1/callback`);
  });

  test('GitHub accepts the target Supabase callback URI', async ({ request }) => {
    const frontendCallback = new URL('/auth/callback', frontendUrl);
    frontendCallback.searchParams.set('returnUrl', '/projects?kortix_use2_github_oauth_smoke=1');
    const authorize = await request.get(authorizeUrlFor('github', frontendCallback), {
      maxRedirects: 0,
    });
    // The web app offers Google and Apple only. GitHub is an optional Supabase
    // provider: enabled on production, disabled on dev and staging, where
    // authorize answers 400 `validation_failed`.
    test.skip(
      authorize.status() === 400 && (await authorize.text()).includes('provider is not enabled'),
      'GitHub is not an enabled Supabase auth provider on this target.',
    );
    expect(authorize.status()).toBe(302);
    const githubUrl = new URL(authorize.headers().location ?? '');
    expect(githubUrl.hostname).toBe('github.com');
    expect(githubUrl.pathname).toBe('/login/oauth/authorize');
    expect(githubUrl.searchParams.get('client_id')).toBeTruthy();
    expect(githubUrl.searchParams.get('redirect_uri')).toBe(`${supabaseUrl}/auth/v1/callback`);
  });
});
