/**
 * Unit tests for the GitHub App's OWN OAuth identity-proof flow — the
 * App-native replacement for routing account-linking's "prove your GitHub
 * identity" step through Supabase's separate, dual-purpose GitHub login
 * provider (which broke in production when that unrelated provider was
 * disabled on the dev Supabase project — the flow's uptime should never have
 * depended on it).
 *
 * Covers:
 *  - githubAppClientId / githubAppClientSecret / isGithubAppOAuthConfigured
 *    (projects/github.ts) — DB-first, env-fallback, same shape as every
 *    other githubApp* accessor.
 *  - signGitHubOAuthState / verifyGitHubOAuthState (platform/routes/
 *    github-app.ts) — the CSRF state round-tripped through GitHub's
 *    /login/oauth/authorize → oauth/callback redirect.
 *  - exchangeGitHubOAuthCode — the code→token exchange against GitHub,
 *    with an injected fetch so no network call is made.
 *
 * Mocks only `platform/services/managed-github-app` (the DB-cache module);
 * everything downstream runs for real. Must run in its own `bun test <file>`
 * invocation — see the same convention/caveat in
 * unit-github-app-isconfigured.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ManagedGithubAppConfig } from '../platform/services/managed-github-app';

let dbConfig: ManagedGithubAppConfig = {};

mock.module('../platform/services/managed-github-app', () => ({
  managedGithubAppConfig: () => dbConfig,
  refreshManagedGithubAppConfig: async () => {},
  invalidateManagedGithubAppConfig: () => {},
  resetManagedGithubAppConfig: async () => {
    dbConfig = {};
  },
  updateManagedGithubAppConfig: async (patch: ManagedGithubAppConfig) => {
    dbConfig = { ...dbConfig, ...patch };
    return dbConfig;
  },
}));

const {
  githubAppClientId,
  githubAppClientSecret,
  isGithubAppOAuthConfigured,
  normalizeGitHubFrontendOrigin,
} = await import('../projects/github');
const { signGitHubOAuthState, verifyGitHubOAuthState, exchangeGitHubOAuthCode } = await import(
  '../platform/routes/github-app'
);

const ENV_KEYS = [
  'KORTIX_GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_ID',
  'KORTIX_GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_CLIENT_SECRET',
  'KORTIX_GITHUB_APP_STATE_SECRET',
  'SUPABASE_JWT_SECRET',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

beforeEach(() => {
  dbConfig = {};
  for (const k of ENV_KEYS) delete process.env[k];
  // Deliberately the App's OWN state secret, NOT SUPABASE_JWT_SECRET: a
  // hosted deployment sets this one and no Supabase JWT secret at all.
  // Binding the OAuth state to SUPABASE_JWT_SECRET made every authorize
  // call fail there — caught by driving the real route over HTTP, not by
  // these unit tests, hence the explicit coverage below.
  process.env.KORTIX_GITHUB_APP_STATE_SECRET = 'test-github-state-secret';
});

describe('githubAppClientId / githubAppClientSecret (DB-first, env-fallback)', () => {
  test('null when nothing is configured', () => {
    expect(githubAppClientId()).toBeNull();
    expect(githubAppClientSecret()).toBeNull();
  });

  test('reads from the DB config (manifest flow / POST /app)', () => {
    dbConfig = { clientId: 'Iv1.db-client-id', clientSecret: 'db-secret' };
    expect(githubAppClientId()).toBe('Iv1.db-client-id');
    expect(githubAppClientSecret()).toBe('db-secret');
  });

  test('falls back to KORTIX_GITHUB_APP_CLIENT_ID/SECRET (hosted Kortix env config)', () => {
    process.env.KORTIX_GITHUB_APP_CLIENT_ID = 'Iv1.env-client-id';
    process.env.KORTIX_GITHUB_APP_CLIENT_SECRET = 'env-secret';
    expect(githubAppClientId()).toBe('Iv1.env-client-id');
    expect(githubAppClientSecret()).toBe('env-secret');
  });

  test('falls back to the unprefixed GITHUB_APP_CLIENT_ID/SECRET', () => {
    process.env.GITHUB_APP_CLIENT_ID = 'Iv1.unprefixed';
    process.env.GITHUB_APP_CLIENT_SECRET = 'unprefixed-secret';
    expect(githubAppClientId()).toBe('Iv1.unprefixed');
    expect(githubAppClientSecret()).toBe('unprefixed-secret');
  });

  test('DB value wins over env when both are set', () => {
    dbConfig = { clientId: 'from-db' };
    process.env.KORTIX_GITHUB_APP_CLIENT_ID = 'from-env';
    expect(githubAppClientId()).toBe('from-db');
  });
});

describe('isGithubAppOAuthConfigured — independent of isGithubAppConfigured', () => {
  test('false with nothing set', () => {
    expect(isGithubAppOAuthConfigured()).toBe(false);
  });

  test('false with only a client id (secret missing — e.g. a pasted App with no OAuth creds)', () => {
    dbConfig = { clientId: 'Iv1.abc' };
    expect(isGithubAppOAuthConfigured()).toBe(false);
  });

  test('true once both client id and secret are present, regardless of appId/privateKey', () => {
    dbConfig = { clientId: 'Iv1.abc', clientSecret: 'shh' };
    expect(isGithubAppOAuthConfigured()).toBe(true);
  });
});

describe('signGitHubOAuthState / verifyGitHubOAuthState', () => {
  test('round-trips a nonce and expiry', () => {
    const token = signGitHubOAuthState();
    const verified = verifyGitHubOAuthState(token);
    expect(verified?.nonce).toBeTruthy();
    expect(typeof verified?.exp).toBe('number');
  });

  test('carries NO redirect target (the CWE-601 fix)', () => {
    // The state deliberately holds no origin. An earlier revision signed a
    // caller-supplied `frontend_origin` into it and the callback redirected
    // the exchanged GitHub token there, so any attacker HTTPS origin could
    // receive a victim's user-to-server token. If a redirect target ever
    // reappears in this payload, that hole is back.
    const token = signGitHubOAuthState();
    const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['exp', 'nonce']);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  test('returns null for undefined/null/empty', () => {
    expect(verifyGitHubOAuthState(undefined)).toBeNull();
    expect(verifyGitHubOAuthState(null)).toBeNull();
    expect(verifyGitHubOAuthState('')).toBeNull();
  });

  test('returns null for a malformed token (wrong part count)', () => {
    expect(verifyGitHubOAuthState('only-one-part')).toBeNull();
    expect(verifyGitHubOAuthState('a.b.c')).toBeNull();
  });

  test('returns null when the signature is tampered', () => {
    const token = signGitHubOAuthState();
    const [body, mac] = token.split('.');
    const tamperedMac = mac!.endsWith('A') ? mac!.slice(0, -1) + 'B' : mac!.slice(0, -1) + 'A';
    expect(verifyGitHubOAuthState(`${body}.${tamperedMac}`)).toBeNull();
  });

  test('returns null when the payload is tampered (re-signing is required)', () => {
    const token = signGitHubOAuthState();
    const [body, mac] = token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    payload.exp = Date.now() + 10 * 60 * 60 * 1000; // try to extend the TTL
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifyGitHubOAuthState(`${forged}.${mac}`)).toBeNull();
  });

  test('returns null past the 10-minute TTL', () => {
    const elevenMinAgo = Date.now() - 11 * 60 * 1000;
    const token = signGitHubOAuthState(elevenMinAgo);
    expect(verifyGitHubOAuthState(token, Date.now())).toBeNull();
  });

  test('accepts a token just inside the 10-minute TTL', () => {
    const nineMinAgo = Date.now() - 9 * 60 * 1000;
    const token = signGitHubOAuthState(nineMinAgo);
    expect(verifyGitHubOAuthState(token, Date.now())?.nonce).toBeTruthy();
  });

  test('two states carry different nonces', () => {
    expect(verifyGitHubOAuthState(signGitHubOAuthState())?.nonce).not.toBe(
      verifyGitHubOAuthState(signGitHubOAuthState())?.nonce,
    );
  });

  test('signs off the App state secret, NOT SUPABASE_JWT_SECRET', () => {
    // Regression: the OAuth state originally reused the manifest flow's
    // SUPABASE_JWT_SECRET-only secret. A hosted deployment sets
    // KORTIX_GITHUB_APP_STATE_SECRET and no SUPABASE_JWT_SECRET, so every
    // authorize call 302'd to an error instead of reaching GitHub.
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.KORTIX_GITHUB_APP_STATE_SECRET = 'only-the-app-secret';
    expect(verifyGitHubOAuthState(signGitHubOAuthState())?.nonce).toBeTruthy();
  });

  test('falls back to the App private key when no explicit state secret is set', () => {
    delete process.env.KORTIX_GITHUB_APP_STATE_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    dbConfig = { privateKey: 'PEM-CONTENT-AS-SECRET' };
    expect(verifyGitHubOAuthState(signGitHubOAuthState())?.nonce).toBeTruthy();
  });

  test('throws when no signing secret is available at all', () => {
    delete process.env.KORTIX_GITHUB_APP_STATE_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    dbConfig = {};
    expect(() => signGitHubOAuthState()).toThrow(/state secret/i);
  });
});

describe('normalizeGitHubFrontendOrigin — the authorize route\'s open-redirect guard', () => {
  // GHA-3 caught the real bug this pins: oauth/authorize's early
  // `oauth_not_configured` return redirected to the RAW `frontend_origin`
  // query param, bypassing validation entirely and turning the route into an
  // open redirect. The route now normalizes the param before any redirect can
  // reference it; these cases pin what "valid" means.
  test('accepts https origins', () => {
    expect(normalizeGitHubFrontendOrigin('https://dev.kortix.com')).toBe('https://dev.kortix.com');
  });

  test('accepts http only on localhost/127.0.0.1', () => {
    expect(normalizeGitHubFrontendOrigin('http://localhost:27800')).toBe('http://localhost:27800');
    expect(normalizeGitHubFrontendOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  test('rejects a plain http origin on any other host', () => {
    expect(normalizeGitHubFrontendOrigin('http://attacker.example')).toBeUndefined();
  });

  test('rejects non-URL, empty, and credential-bearing values', () => {
    expect(normalizeGitHubFrontendOrigin('not-a-url')).toBeUndefined();
    expect(normalizeGitHubFrontendOrigin('')).toBeUndefined();
    expect(normalizeGitHubFrontendOrigin('https://user:pass@evil.example')).toBeUndefined();
  });

  test('strips any path/query, keeping only the origin', () => {
    expect(normalizeGitHubFrontendOrigin('https://dev.kortix.com/a/b?c=d')).toBe(
      'https://dev.kortix.com',
    );
  });
});

describe('exchangeGitHubOAuthCode', () => {
  test('throws when OAuth client credentials are not configured', async () => {
    await expect(
      exchangeGitHubOAuthCode({ code: 'abc', redirectUri: 'https://dev-api.kortix.com/cb' }),
    ).rejects.toThrow(/not configured/i);
  });

  test('returns the access token on a successful exchange, posting client creds + code + redirect_uri', async () => {
    dbConfig = { clientId: 'Iv1.client', clientSecret: 'shh' };
    let capturedBody: any = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ access_token: 'ghu_token123' }), { status: 200 });
    }) as unknown as typeof fetch;

    const token = await exchangeGitHubOAuthCode(
      { code: 'the-code', redirectUri: 'https://dev-api.kortix.com/v1/platform/github-app/oauth/callback' },
      fetchImpl,
    );

    expect(token).toBe('ghu_token123');
    expect(capturedBody).toEqual({
      client_id: 'Iv1.client',
      client_secret: 'shh',
      code: 'the-code',
      redirect_uri: 'https://dev-api.kortix.com/v1/platform/github-app/oauth/callback',
    });
  });

  test('throws when GitHub responds with an OAuth error body', async () => {
    dbConfig = { clientId: 'Iv1.client', clientSecret: 'shh' };
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(
      exchangeGitHubOAuthCode({ code: 'stale', redirectUri: 'https://x/cb' }, fetchImpl),
    ).rejects.toThrow(/incorrect or expired/i);
  });

  test('throws when GitHub responds with a non-2xx status', async () => {
    dbConfig = { clientId: 'Iv1.client', clientSecret: 'shh' };
    const fetchImpl = (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;

    await expect(
      exchangeGitHubOAuthCode({ code: 'x', redirectUri: 'https://x/cb' }, fetchImpl),
    ).rejects.toThrow(/500/);
  });
});
