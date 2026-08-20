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
 *   verifyOtp           POST {url}/auth/v1/verify  (2 body shapes)          :1970
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

/**
 * The two things `/auth/v1/verify` accepts, as a union so a caller must supply
 * exactly one of them. Mixing the forms is not a style question: GoTrue
 * v2.194.0 answers `403 otp_expired` to `{email, token: <hash>}`.
 *
 * - **Code form** — `{ email, token }`, where `token` is the 6-digit code. It
 *   only exists if the deployment's email template renders `{{ .Token }}`.
 *   Kortix's own template (`apps/api/src/auth/send-email-hook/templates.ts`)
 *   and the stock GoTrue template do NOT: they render a link only.
 * - **Link form** — `{ token_hash, type }`, read off that emailed link
 *   (`/auth/v1/verify?token=<56-hex-hash>&type=magiclink`). The link's `token`
 *   query parameter IS the `token_hash`; `type` must be the link's own `type`,
 *   which is why it is required here rather than defaulted.
 */
export type KortixVerifyOtpInput =
  | {
      email: string;
      token: string;
      /** Default `'email'`. */
      type?: KortixVerifyOtpType;
      token_hash?: never;
      captchaToken?: string;
      signal?: AbortSignal;
    }
  | {
      token_hash: string;
      /** Required: take it from the emailed link's `type` query parameter. */
      type: KortixVerifyOtpType;
      email?: never;
      token?: never;
      captchaToken?: string;
      signal?: AbortSignal;
    };

function isTokenHashForm(
  input: KortixVerifyOtpInput,
): input is Extract<KortixVerifyOtpInput, { token_hash: string }> {
  return typeof (input as { token_hash?: unknown }).token_hash === 'string';
}

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
  input: KortixVerifyOtpInput,
): Promise<KortixAuthSession> {
  // Send ONE shape or the other. A `token_hash` request that also carries
  // `email`/`token` is the request GoTrue rejects.
  const identity = isTokenHashForm(input)
    ? { token_hash: input.token_hash, type: input.type }
    : { email: input.email, token: input.token, type: input.type ?? 'email' };

  const body = await request(ctx, endpoint(ctx, '/verify'), {
    method: 'POST',
    body: { ...identity, gotrue_meta_security: { captcha_token: input.captchaToken } },
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
