/**
 * Headless regular auth — `/v1/auth/*` public routes.
 *
 * Sign-up, password sign-in, magic link + OTP, social sign-in (PKCE), refresh
 * and password reset, served by the Kortix API so a client (the SDK, a CLI, a
 * native app, a third-party backend) never talks to Supabase. Each route is a
 * thin, rate-limited translation to GoTrue (./gotrue.ts); the responses are
 * GoTrue's session and user, with errors passed through as
 * `{error, error_description}` and the upstream status.
 *
 * Bearer-carrying routes (`GET /user`, `POST /password/update`,
 * `POST /sign-out`) live on the authenticated router in ./index.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { makeOpenApiApp, json, errors } from '../openapi';
import type { AppEnv } from '../types';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { auditLoginFail } from '../shared/auth-audit';
import { gotrue, gotrueAuthorizeUrl, sessionFrom, type GoTrueSession, type GoTrueUser } from './gotrue';

export const headlessAuthRouter = makeOpenApiApp<AppEnv>();

const limiter = new TokenBucketRateLimiter('headless-auth');
/** Per client IP: generous for a human, tight enough to blunt credential stuffing. */
const IP_POLICY = { limit: 30, windowMs: 60_000 };

const SessionSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.string(),
    expires_in: z.number(),
    expires_at: z.number().optional(),
  })
  .openapi('AuthSession');
const UserSchema = z.object({ id: z.string(), email: z.string().nullable().optional() }).passthrough().openapi('AuthUser');
const SessionResponse = z.object({ session: SessionSchema, user: UserSchema });
const Email = z.string().email().max(320);
const OTP_TYPES = ['magiclink', 'signup', 'recovery', 'email', 'email_change'] as const;

function clientIp(c: Context): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;
}

function throttled(c: Context): Response | null {
  const key = clientIp(c) ?? 'unknown';
  const verdict = limiter.check(key, IP_POLICY);
  if (verdict.allowed) return null;
  return c.json(
    { error: 'over_request_rate_limit', error_description: 'Too many authentication attempts. Try again shortly.' },
    429,
    { 'retry-after': String(Math.ceil((verdict.retryAfterMs ?? verdict.resetMs) / 1000)) },
  );
}

/** `redirect_to` is handed to GoTrue, which enforces its own allow-list; we only refuse non-http(s). */
function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function upstreamError(c: Context, result: { status: number; body: { error?: string; error_description?: string } }) {
  const status = result.status >= 400 && result.status < 600 ? result.status : 502;
  return c.json({ error: result.body.error ?? 'auth_error', error_description: result.body.error_description ?? '' }, status as never);
}

function sessionResponse(c: Context, body: Record<string, unknown>, status: 200 | 201 = 200) {
  const session = sessionFrom(body);
  if (!session) {
    return c.json({ error: 'auth_error', error_description: 'Supabase returned no session' }, 502);
  }
  return c.json({ session, user: (body.user as GoTrueUser | undefined) ?? null }, status);
}

// ─── POST /signup ───────────────────────────────────────────────────────────

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/signup',
    tags: ['auth'],
    summary: 'Create an account with email + password (headless)',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              email: Email,
              password: z.string().min(8).max(256),
              data: z.record(z.unknown()).optional(),
              redirect_to: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({ user: UserSchema.nullable(), session: SessionSchema.nullable(), requires_email_confirmation: z.boolean() }),
        'Created. `session` is null until the email is confirmed when confirmation is required.',
      ),
      ...errors(400, 422, 429),
    },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const result = await gotrue<Record<string, unknown>>('/signup', {
      body: { email: body.email.trim().toLowerCase(), password: body.password, data: body.data ?? {} },
      clientIp: clientIp(c),
      query: { redirect_to: safeRedirect(body.redirect_to) },
    });
    if (!result.ok) {
      auditLoginFail({ c, reason: `signup_failed:${result.body.error ?? result.status}`, authType: 'supabase' });
      return upstreamError(c, result);
    }
    const session = sessionFrom(result.body);
    // GoTrue answers a bare user (no session) when email confirmation is on.
    const user = (result.body.user as GoTrueUser | undefined) ?? (typeof result.body.id === 'string' ? (result.body as GoTrueUser) : null);
    return c.json({ user, session, requires_email_confirmation: session === null }, 200);
  },
);

// ─── POST /sign-in/password ─────────────────────────────────────────────────

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sign-in/password',
    tags: ['auth'],
    summary: 'Sign in with email + password (headless)',
    request: { body: { content: { 'application/json': { schema: z.object({ email: Email, password: z.string().min(1).max(256) }) } } } },
    responses: { 200: json(SessionResponse, 'The session'), ...errors(400, 429) },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const result = await gotrue<Record<string, unknown>>('/token', {
      body: { email: body.email.trim().toLowerCase(), password: body.password },
      clientIp: clientIp(c),
      query: { grant_type: 'password' },
    });
    if (!result.ok) {
      auditLoginFail({ c, reason: `password_rejected:${result.body.error ?? result.status}`, authType: 'supabase' });
      return upstreamError(c, result);
    }
    return sessionResponse(c, result.body);
  },
);

// ─── POST /sign-in/magic-link ───────────────────────────────────────────────

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sign-in/magic-link',
    tags: ['auth'],
    summary: 'Email a magic link / one-time code (headless)',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              email: Email,
              create_user: z.boolean().optional(),
              redirect_to: z.string().optional(),
              data: z.record(z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(z.object({ sent: z.literal(true) }), 'Email sent'), ...errors(400, 422, 429) },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const result = await gotrue('/otp', {
      body: { email: body.email.trim().toLowerCase(), create_user: body.create_user ?? true, data: body.data ?? {} },
      clientIp: clientIp(c),
      query: { redirect_to: safeRedirect(body.redirect_to) },
    });
    if (!result.ok) return upstreamError(c, result);
    return c.json({ sent: true as const });
  },
);

// ─── POST /verify-otp ───────────────────────────────────────────────────────

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/verify-otp',
    tags: ['auth'],
    summary: 'Exchange an emailed code for a session (headless)',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ email: Email, token: z.string().min(4).max(64), type: z.enum(OTP_TYPES) }),
          },
        },
      },
    },
    responses: { 200: json(SessionResponse, 'The session'), ...errors(400, 429) },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const result = await gotrue<Record<string, unknown>>('/verify', {
      body: { email: body.email.trim().toLowerCase(), token: body.token.trim(), type: body.type },
      clientIp: clientIp(c),
    });
    if (!result.ok) {
      auditLoginFail({ c, reason: `otp_rejected:${result.body.error ?? result.status}`, authType: 'supabase' });
      return upstreamError(c, result);
    }
    return sessionResponse(c, result.body);
  },
);

// ─── POST /sign-in/oauth  (social, PKCE) ────────────────────────────────────

const PROVIDERS = ['google', 'github', 'azure', 'apple', 'gitlab', 'bitbucket', 'discord', 'slack', 'linkedin_oidc', 'keycloak', 'workos', 'sso'] as const;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sign-in/oauth',
    tags: ['auth'],
    summary: 'Start a social sign-in (PKCE): returns the provider URL and the code verifier to keep',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ provider: z.enum(PROVIDERS), redirect_to: z.string(), scopes: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ url: z.string(), code_verifier: z.string() }), 'Send the user to `url`; keep `code_verifier` for /oauth/exchange'),
      ...errors(400, 429),
    },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const redirectTo = safeRedirect(body.redirect_to);
    if (!redirectTo) return c.json({ error: 'invalid_request', error_description: 'redirect_to must be an absolute http(s) URL' }, 400);
    const verifierBytes = new Uint8Array(48);
    crypto.getRandomValues(verifierBytes);
    const codeVerifier = b64url(verifierBytes);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));
    const result = await gotrueAuthorizeUrl({
      provider: body.provider,
      redirect_to: redirectTo,
      scopes: body.scopes,
      code_challenge: challenge,
      code_challenge_method: 's256',
    });
    if (!result.ok) return upstreamError(c, result);
    return c.json({ url: result.body.url, code_verifier: codeVerifier });
  },
);

// ─── POST /oauth/exchange ───────────────────────────────────────────────────

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/oauth/exchange',
    tags: ['auth'],
    summary: 'Exchange the social sign-in code (+ PKCE verifier) for a session',
    request: { body: { content: { 'application/json': { schema: z.object({ code: z.string().min(1), code_verifier: z.string().min(1) }) } } } },
    responses: { 200: json(SessionResponse, 'The session'), ...errors(400, 429) },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const result = await gotrue<Record<string, unknown>>('/token', {
      body: { auth_code: body.code, code_verifier: body.code_verifier },
      clientIp: clientIp(c),
      query: { grant_type: 'pkce' },
    });
    if (!result.ok) {
      auditLoginFail({ c, reason: `oauth_exchange_rejected:${result.body.error ?? result.status}`, authType: 'supabase' });
      return upstreamError(c, result);
    }
    return sessionResponse(c, result.body);
  },
);

// ─── POST /refresh ──────────────────────────────────────────────────────────

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/refresh',
    tags: ['auth'],
    summary: 'Rotate a session with its refresh token (headless)',
    request: { body: { content: { 'application/json': { schema: z.object({ refresh_token: z.string().min(1) }) } } } },
    responses: { 200: json(SessionResponse, 'The new session'), ...errors(400, 429) },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const result = await gotrue<Record<string, unknown>>('/token', {
      body: { refresh_token: body.refresh_token },
      clientIp: clientIp(c),
      query: { grant_type: 'refresh_token' },
    });
    if (!result.ok) return upstreamError(c, result);
    return sessionResponse(c, result.body);
  },
);

// ─── POST /password/reset ───────────────────────────────────────────────────

headlessAuthRouter.openapi(
  createRoute({
    method: 'post',
    path: '/password/reset',
    tags: ['auth'],
    summary: 'Email a password-recovery link / code (headless)',
    request: { body: { content: { 'application/json': { schema: z.object({ email: Email, redirect_to: z.string().optional() }) } } } },
    responses: { 200: json(z.object({ sent: z.literal(true) }), 'Email sent (also when the address is unknown)'), ...errors(400, 429) },
  }),
  async (c: any): Promise<any> => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = c.req.valid('json');
    const result = await gotrue('/recover', {
      body: { email: body.email.trim().toLowerCase() },
      clientIp: clientIp(c),
      query: { redirect_to: safeRedirect(body.redirect_to) },
    });
    // Never reveal whether the address exists: GoTrue already answers 200 for
    // unknown emails; only a genuine upstream failure or rate limit surfaces.
    if (!result.ok && result.status !== 404 && result.status !== 422) return upstreamError(c, result);
    return c.json({ sent: true as const });
  },
);

export type { GoTrueSession };
