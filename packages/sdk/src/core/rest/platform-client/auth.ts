/**
 * Headless regular auth — `kortix.auth.*`.
 *
 * Sign-up, password sign-in, magic link + one-time code, social sign-in (PKCE),
 * refresh, password reset and update, sign-out — all through the Kortix API
 * (`/v1/auth/*`), never Supabase. Works identically against kortix.com and a
 * self-host. Pair with `createKortixSession` for a token store that refreshes
 * itself and feeds `createKortix({ getToken })`.
 *
 * Unauthenticated calls read `backendUrl` from the platform config; the
 * bearer-carrying ones (`user`, `updatePassword`, `signOut`) take the access
 * token explicitly so a host can call them before its `getToken` is wired.
 */
import { platformConfig } from '../../http/config';
import { stripTrailingSlashes } from '../../../platform/strings';
import type { KortixSession, KortixSessionOptions } from '../../auth/session';

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  /** Epoch seconds. */
  expires_at?: number;
}

export interface AuthUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuthSessionResult {
  session: AuthSession;
  user: AuthUser | null;
}

export type AuthOtpType = 'magiclink' | 'signup' | 'recovery' | 'email' | 'email_change';
export type AuthProvider =
  | 'google'
  | 'github'
  | 'azure'
  | 'apple'
  | 'gitlab'
  | 'bitbucket'
  | 'discord'
  | 'slack'
  | 'linkedin_oidc'
  | 'keycloak'
  | 'workos'
  | 'sso';

/** `{error, error_description}` + the upstream status, thrown by every `kortix.auth.*` call. */
export class HeadlessAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HeadlessAuthError';
  }
}

export interface AuthRequestOptions {
  /** Overrides `platformConfig().backendUrl`. */
  backendUrl?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}

function apiBase(opts?: AuthRequestOptions): string {
  const raw = stripTrailingSlashes(opts?.backendUrl ?? platformConfig().backendUrl ?? '');
  if (!raw) throw new HeadlessAuthError('not_configured', 'backendUrl is not configured (configureKortix / createKortix first)', 0);
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; bearer?: string },
  opts?: AuthRequestOptions,
): Promise<T> {
  const fetchImpl = opts?.fetch ?? platformConfig().fetch ?? ((input: RequestInfo | URL, i?: RequestInit) => fetch(input, i));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  const res = await fetchImpl(`${apiBase(opts)}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const r = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    throw new HeadlessAuthError(
      typeof r.error === 'string' ? r.error : 'auth_error',
      typeof r.error_description === 'string' && r.error_description
        ? r.error_description
        : typeof r.error === 'string'
          ? r.error
          : res.statusText || `HTTP ${res.status}`,
      res.status,
    );
  }
  return body as T;
}

export function signUp(
  input: { email: string; password: string; data?: Record<string, unknown>; redirect_to?: string },
  opts?: AuthRequestOptions,
) {
  return call<{ user: AuthUser | null; session: AuthSession | null; requires_email_confirmation: boolean }>(
    '/auth/signup',
    { body: input },
    opts,
  );
}

export function signInWithPassword(input: { email: string; password: string }, opts?: AuthRequestOptions) {
  return call<AuthSessionResult>('/auth/sign-in/password', { body: input }, opts);
}

export function sendMagicLink(
  input: { email: string; create_user?: boolean; redirect_to?: string; data?: Record<string, unknown> },
  opts?: AuthRequestOptions,
) {
  return call<{ sent: true }>('/auth/sign-in/magic-link', { body: input }, opts);
}

export function verifyOtp(input: { email: string; token: string; type: AuthOtpType }, opts?: AuthRequestOptions) {
  return call<AuthSessionResult>('/auth/verify-otp', { body: input }, opts);
}

/** Returns the provider URL to send the user to, and the PKCE verifier to keep for `exchangeCode`. */
export function signInWithProvider(
  input: { provider: AuthProvider; redirect_to: string; scopes?: string },
  opts?: AuthRequestOptions,
) {
  return call<{ url: string; code_verifier: string }>('/auth/sign-in/oauth', { body: input }, opts);
}

export function exchangeCode(input: { code: string; code_verifier: string }, opts?: AuthRequestOptions) {
  return call<AuthSessionResult>('/auth/oauth/exchange', { body: input }, opts);
}

export function refreshSession(input: { refresh_token: string }, opts?: AuthRequestOptions) {
  return call<AuthSessionResult>('/auth/refresh', { body: input }, opts);
}

export function resetPassword(input: { email: string; redirect_to?: string }, opts?: AuthRequestOptions) {
  return call<{ sent: true }>('/auth/password/reset', { body: input }, opts);
}

export function updatePassword(input: { password: string }, accessToken: string, opts?: AuthRequestOptions) {
  return call<{ user: AuthUser }>('/auth/password/update', { body: input, bearer: accessToken }, opts);
}

export function authUser(accessToken: string, opts?: AuthRequestOptions) {
  return call<{ user: AuthUser }>('/auth/user', { bearer: accessToken }, opts);
}

export function signOut(accessToken: string, input: { scope?: 'global' | 'local' | 'others' } = {}, opts?: AuthRequestOptions) {
  return call<{ ok: true }>('/auth/sign-out', { body: input, bearer: accessToken }, opts);
}

/**
 * The shape of `kortix.auth`. A named interface (not an inferred object type)
 * so `Kortix` stays nameable from every entry point — a consumer's declaration
 * emit otherwise fails with TS2742 pointing at this file's path.
 */
export interface HeadlessAuthApi {
  signUp: typeof signUp;
  signInWithPassword: typeof signInWithPassword;
  sendMagicLink: typeof sendMagicLink;
  verifyOtp: typeof verifyOtp;
  signInWithProvider: typeof signInWithProvider;
  exchangeCode: typeof exchangeCode;
  refresh: typeof refreshSession;
  resetPassword: typeof resetPassword;
  updatePassword: typeof updatePassword;
  user: typeof authUser;
  signOut: typeof signOut;
  /** A self-refreshing session store; wire `session.getToken` into `createKortix`. */
  session: (options?: KortixSessionOptions) => KortixSession;
}
