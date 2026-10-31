import { describe, expect, test } from 'bun:test';
import { createClient } from '@supabase/supabase-js';

import { oauthQueryParams, prefersEphemeralAuthSession } from './oauth-browser';

const supabase = createClient('https://project.example.test', 'anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/** The URL the browser opens: the one `useAuth.signInWithOAuth` builds. */
async function authorizeUrl(provider: 'google' | 'apple') {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: 'kortix://auth/callback',
      skipBrowserRedirect: true,
      queryParams: oauthQueryParams(provider),
    },
  });
  expect(error).toBeNull();
  return new URL(data.url!);
}

describe('Google sign-in', () => {
  test('asks Google for its account list on the URL the browser opens', async () => {
    const url = await authorizeUrl('google');
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_to')).toBe('kortix://auth/callback');
  });

  test('opens in the shared browser session, so Safari accounts are listed', () => {
    expect(prefersEphemeralAuthSession('google')).toBe(false);
  });
});

describe('other sign-in paths', () => {
  test('Apple sends no prompt', async () => {
    expect((await authorizeUrl('apple')).searchParams.has('prompt')).toBe(false);
  });

  test('every provider except Google keeps its isolated session', () => {
    expect(prefersEphemeralAuthSession('sso')).toBe(true);
    expect(prefersEphemeralAuthSession('apple')).toBe(true);
    expect(prefersEphemeralAuthSession('github')).toBe(true);
  });
});
