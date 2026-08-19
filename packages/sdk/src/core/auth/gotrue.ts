/**
 * GoTrue REST, mirrored exactly — and holding NO state.
 *
 * Every function takes its context (`{ url, anonKey, fetch }`) explicitly.
 * That is what makes this layer unit-testable against an injected `fetch`
 * without constructing a client, and it is why `client.ts` can stay about
 * caching and events rather than about HTTP.
 *
 * Endpoints and body shapes are verified against `@supabase/auth-js@2.110.0`
 * (`dist/module/GoTrueClient.js`), so a deployment's GoTrue sees byte-identical
 * requests whether the caller uses supabase-js or this SDK:
 *
 *   signInWithPassword  POST {url}/auth/v1/token?grant_type=password        :885
 *   signInWithOtp       POST {url}/auth/v1/otp  (+ ?redirect_to=)           :1783
 *   verifyOtp           POST {url}/auth/v1/verify                           :1970
 *   refresh             POST {url}/auth/v1/token?grant_type=refresh_token   :3907
 *   signOut             POST {url}/auth/v1/logout?scope=global  + Bearer    GoTrueAdminApi.js:70
 *   getUser             GET  {url}/auth/v1/user                 + Bearer    :2611
 *   authorize           GET  {url}/auth/v1/authorize?provider=…  (URL only) :3940
 *   exchangeCode        POST {url}/auth/v1/token?grant_type=pkce            :1549
 *
 * `apikey: <anon_key>` goes on every request. `Authorization: Bearer` goes on
 * exactly two — logout and user — because those act on a specific session.
 */

import { authErrorFromResponse, readResponseBody, type AuthFetch } from './errors';
import { normalizeSession, type KortixAuthSession, type KortixAuthUser } from './session';

/** Everything a GoTrue call needs. No instance, no hidden state. */
export interface GoTrueContext {
  /** GoTrue ORIGIN, no `/auth/v1` suffix and no trailing slash. */
  url: string;
  anonKey: string;
  fetch: AuthFetch;
}

/** The OTP/verify types this module supports (email only — see the non-goals). */
export type KortixVerifyOtpType =
  | 'email'
  | 'magiclink'
  | 'signup'
  | 'recovery'
  | 'invite'
  | 'email_change';

/** Sign-out blast radius, as GoTrue defines it. */
export type KortixSignOutScope = 'global' | 'local' | 'others';

function endpoint(ctx: GoTrueContext, path: string): string {
  return `${ctx.url}/auth/v1${path}`;
}

function baseHeaders(ctx: GoTrueContext, accessToken?: string): Record<string, string> {
  return {
    apikey: ctx.anonKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function request(
  ctx: GoTrueContext,
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string; signal?: AbortSignal },
): Promise<unknown> {
  const response = await ctx.fetch(url, {
    method: init.method,
    headers: baseHeaders(ctx, init.accessToken),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });

  const body = await readResponseBody(response);
  if (!response.ok) throw authErrorFromResponse(response, body, `GoTrue ${url} failed`);
  return body;
}

export async function gotrueSignInWithPassword(
  ctx: GoTrueContext,
  input: { email: string; password: string; signal?: AbortSignal },
): Promise<KortixAuthSession> {
  const body = await request(ctx, endpoint(ctx, '/token?grant_type=password'), {
    method: 'POST',
    body: { email: input.email, password: input.password },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return normalizeSession(body as Record<string, unknown>);
}

export async function gotrueSignInWithOtp(
  ctx: GoTrueContext,
  input: {
    email: string;
    redirectTo?: string;
    shouldCreateUser?: boolean;
    data?: Record<string, unknown>;
    captchaToken?: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  const query = input.redirectTo ? `?redirect_to=${encodeURIComponent(input.redirectTo)}` : '';
  await request(ctx, endpoint(ctx, `/otp${query}`), {
    method: 'POST',
    body: {
      email: input.email,
      data: input.data ?? {},
      create_user: input.shouldCreateUser ?? true,
      gotrue_meta_security: { captcha_token: input.captchaToken },
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function gotrueVerifyOtp(
  ctx: GoTrueContext,
  input: {
    email: string;
    token: string;
    type?: KortixVerifyOtpType;
    captchaToken?: string;
    signal?: AbortSignal;
  },
): Promise<KortixAuthSession> {
  const body = await request(ctx, endpoint(ctx, '/verify'), {
    method: 'POST',
    body: {
      email: input.email,
      token: input.token,
      type: input.type ?? 'email',
      gotrue_meta_security: { captcha_token: input.captchaToken },
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return normalizeSession(body as Record<string, unknown>);
}

export async function gotrueRefreshSession(
  ctx: GoTrueContext,
  refreshToken: string,
): Promise<KortixAuthSession> {
  const body = await request(ctx, endpoint(ctx, '/token?grant_type=refresh_token'), {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
  return normalizeSession(body as Record<string, unknown>);
}

export async function gotrueSignOut(
  ctx: GoTrueContext,
  accessToken: string,
  scope: KortixSignOutScope = 'global',
): Promise<void> {
  await request(ctx, endpoint(ctx, `/logout?scope=${scope}`), {
    method: 'POST',
    accessToken,
  });
}

export async function gotrueGetUser(
  ctx: GoTrueContext,
  accessToken: string,
): Promise<KortixAuthUser | null> {
  const body = await request(ctx, endpoint(ctx, '/user'), { method: 'GET', accessToken });
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  // GoTrue answers `/user` with the user object itself; some proxies wrap it.
  const user = typeof record.id === 'string' ? record : (record.user as Record<string, unknown>);
  return user && typeof user.id === 'string' ? (user as unknown as KortixAuthUser) : null;
}

/**
 * Build the provider authorize URL. Issues NO request — the SDK never
 * navigates, opens a popup, or registers a deep-link handler (see the
 * non-goals); the host owns the redirect.
 */
export function gotrueAuthorizeUrl(
  ctx: GoTrueContext,
  input: { provider: string; redirectTo?: string; scopes?: string; codeChallenge: string },
): string {
  const params = [`provider=${encodeURIComponent(input.provider)}`];
  if (input.redirectTo) params.push(`redirect_to=${encodeURIComponent(input.redirectTo)}`);
  if (input.scopes) params.push(`scopes=${encodeURIComponent(input.scopes)}`);
  params.push(`code_challenge=${encodeURIComponent(input.codeChallenge)}`);
  params.push('code_challenge_method=S256');
  return `${endpoint(ctx, '/authorize')}?${params.join('&')}`;
}

export async function gotrueExchangeCodeForSession(
  ctx: GoTrueContext,
  input: { authCode: string; codeVerifier: string },
): Promise<KortixAuthSession> {
  const body = await request(ctx, endpoint(ctx, '/token?grant_type=pkce'), {
    method: 'POST',
    body: { auth_code: input.authCode, code_verifier: input.codeVerifier },
  });
  return normalizeSession(body as Record<string, unknown>);
}
