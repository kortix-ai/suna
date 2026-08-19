import { describe, expect, test } from 'bun:test';

import { KortixAuthError } from './errors';
import {
  gotrueAuthorizeUrl,
  gotrueExchangeCodeForSession,
  gotrueGetUser,
  gotrueRefreshSession,
  gotrueSignInWithOtp,
  gotrueSignInWithPassword,
  gotrueSignOut,
  gotrueVerifyOtp,
  type GoTrueContext,
} from './gotrue';

const SESSION_BODY = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'u1', email: 'a@b.test' },
};

interface Capture {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function context(respond: (capture: Capture) => Response): {
  ctx: GoTrueContext;
  calls: Capture[];
} {
  const calls: Capture[] = [];
  const ctx: GoTrueContext = {
    url: 'https://supa.kortix.test',
    anonKey: 'anon-key-1',
    fetch: async (input, init) => {
      const capture: Capture = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      };
      calls.push(capture);
      return respond(capture);
    },
  };
  return { ctx, calls };
}

const okSession = () => Response.json(SESSION_BODY);

describe('every GoTrue request', () => {
  test('sends the anon key as apikey and JSON content type', async () => {
    const { ctx, calls } = context(okSession);
    await gotrueSignInWithPassword(ctx, { email: 'a@b.test', password: 'pw' });
    expect(calls[0]?.headers.get('apikey')).toBe('anon-key-1');
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('gotrueSignInWithPassword', () => {
  test('POSTs /auth/v1/token?grant_type=password with email and password', async () => {
    const { ctx, calls } = context(okSession);
    const session = await gotrueSignInWithPassword(ctx, { email: 'a@b.test', password: 'pw' });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/token?grant_type=password');
    expect(calls[0]?.body).toEqual({ email: 'a@b.test', password: 'pw' });
    // Anonymous: the anon key authorizes it, never a bearer token.
    expect(calls[0]?.headers.has('Authorization')).toBe(false);
    expect(session.access_token).toBe('access-1');
    expect(session.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('gotrueSignInWithOtp', () => {
  test('POSTs /auth/v1/otp with create_user defaulting to true', async () => {
    const { ctx, calls } = context(() => Response.json({}));
    await gotrueSignInWithOtp(ctx, { email: 'a@b.test' });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/otp');
    expect(calls[0]?.body).toEqual({
      email: 'a@b.test',
      data: {},
      create_user: true,
      gotrue_meta_security: { captcha_token: undefined },
    });
  });

  test('puts redirectTo in the query as redirect_to and honours shouldCreateUser: false', async () => {
    const { ctx, calls } = context(() => Response.json({}));
    await gotrueSignInWithOtp(ctx, {
      email: 'a@b.test',
      redirectTo: 'https://app.test/callback?next=/projects',
      shouldCreateUser: false,
      data: { invite: 'x' },
    });

    expect(calls[0]?.url).toBe(
      `https://supa.kortix.test/auth/v1/otp?redirect_to=${encodeURIComponent('https://app.test/callback?next=/projects')}`,
    );
    expect(calls[0]?.body).toMatchObject({ create_user: false, data: { invite: 'x' } });
  });
});

describe('gotrueVerifyOtp', () => {
  test('POSTs /auth/v1/verify with email, token, type', async () => {
    const { ctx, calls } = context(okSession);
    const session = await gotrueVerifyOtp(ctx, { email: 'a@b.test', token: '123456', type: 'email' });

    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/verify');
    expect(calls[0]?.body).toEqual({
      email: 'a@b.test',
      token: '123456',
      type: 'email',
      gotrue_meta_security: { captcha_token: undefined },
    });
    expect(session.refresh_token).toBe('refresh-1');
  });
});

describe('gotrueRefreshSession', () => {
  test('POSTs /auth/v1/token?grant_type=refresh_token with the refresh token', async () => {
    const { ctx, calls } = context(okSession);
    await gotrueRefreshSession(ctx, 'refresh-1');

    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/token?grant_type=refresh_token');
    expect(calls[0]?.body).toEqual({ refresh_token: 'refresh-1' });
  });
});

describe('gotrueSignOut', () => {
  test('POSTs /auth/v1/logout?scope=global WITH a bearer token', async () => {
    const { ctx, calls } = context(() => new Response(null, { status: 204 }));
    await gotrueSignOut(ctx, 'access-1');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/logout?scope=global');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer access-1');
  });

  test('honours an explicit scope', async () => {
    const { ctx, calls } = context(() => new Response(null, { status: 204 }));
    await gotrueSignOut(ctx, 'access-1', 'local');
    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/logout?scope=local');
  });
});

describe('gotrueGetUser', () => {
  test('GETs /auth/v1/user WITH a bearer token', async () => {
    const { ctx, calls } = context(() => Response.json({ id: 'u1', email: 'a@b.test' }));
    const user = await gotrueGetUser(ctx, 'access-1');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/user');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer access-1');
    expect(user?.id).toBe('u1');
  });
});

describe('gotrueAuthorizeUrl', () => {
  test('builds the URL only — it issues no request', () => {
    const { ctx, calls } = context(okSession);
    const url = gotrueAuthorizeUrl(ctx, {
      provider: 'google',
      redirectTo: 'https://app.test/callback',
      scopes: 'email profile',
      codeChallenge: 'challenge-1',
    });

    expect(calls).toHaveLength(0);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://supa.kortix.test/auth/v1/authorize');
    expect(parsed.searchParams.get('provider')).toBe('google');
    expect(parsed.searchParams.get('redirect_to')).toBe('https://app.test/callback');
    expect(parsed.searchParams.get('scopes')).toBe('email profile');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('omits optional params it was not given', () => {
    const { ctx } = context(okSession);
    const url = new URL(gotrueAuthorizeUrl(ctx, { provider: 'github', codeChallenge: 'c' }));
    expect(url.searchParams.has('redirect_to')).toBe(false);
    expect(url.searchParams.has('scopes')).toBe(false);
  });
});

describe('gotrueExchangeCodeForSession', () => {
  test('POSTs /auth/v1/token?grant_type=pkce with auth_code and code_verifier', async () => {
    const { ctx, calls } = context(okSession);
    await gotrueExchangeCodeForSession(ctx, { authCode: 'code-1', codeVerifier: 'verifier-1' });

    expect(calls[0]?.url).toBe('https://supa.kortix.test/auth/v1/token?grant_type=pkce');
    expect(calls[0]?.body).toEqual({ auth_code: 'code-1', code_verifier: 'verifier-1' });
  });
});

describe('error mapping', () => {
  test('error_description becomes the message and error_code becomes .code', async () => {
    const { ctx } = context(() =>
      Response.json(
        { error_code: 'invalid_credentials', error_description: 'Invalid login credentials' },
        { status: 400 },
      ),
    );
    const error = (await gotrueSignInWithPassword(ctx, { email: 'a@b.test', password: 'wrong' }).catch(
      (caught: unknown) => caught,
    )) as KortixAuthError;

    expect(error).toBeInstanceOf(KortixAuthError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_credentials');
    expect(error.message).toBe('Invalid login credentials');
    expect(error.body).toMatchObject({ error_code: 'invalid_credentials' });
  });

  test('falls back to error then msg when error_code is absent', async () => {
    const { ctx } = context(() =>
      Response.json({ error: 'invalid_grant', msg: 'Refresh token not found' }, { status: 401 }),
    );
    const error = (await gotrueRefreshSession(ctx, 'dead').catch(
      (caught: unknown) => caught,
    )) as KortixAuthError;

    expect(error.code).toBe('invalid_grant');
    expect(error.message).toBe('Refresh token not found');
  });

  test('tolerates a non-JSON body and still reports the status', async () => {
    const { ctx } = context(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const error = (await gotrueRefreshSession(ctx, 'r').catch(
      (caught: unknown) => caught,
    )) as KortixAuthError;

    expect(error).toBeInstanceOf(KortixAuthError);
    expect(error.status).toBe(502);
    expect(error.code).toBeNull();
    expect(error.body).toBe('<html>502 Bad Gateway</html>');
  });

  test('a 429 rate limit keeps its GoTrue code so callers can back off', async () => {
    const { ctx } = context(() =>
      Response.json(
        { error_code: 'over_email_send_rate_limit', msg: 'For security purposes…' },
        { status: 429 },
      ),
    );
    const error = (await gotrueSignInWithOtp(ctx, { email: 'a@b.test' }).catch(
      (caught: unknown) => caught,
    )) as KortixAuthError;
    expect(error.status).toBe(429);
    expect(error.code).toBe('over_email_send_rate_limit');
  });
});
