/**
 * `createKortixAuth` — "Sign in with Kortix" for a standalone app.
 *
 * A third-party app (a dashboard, an internal tool, a vertical wrapper) mounts
 * ONE catch-all route on `handler()` and gets the whole OAuth 2.1 lifecycle
 * against Kortix: PKCE sign-in, the callback exchange, an encrypted session
 * cookie, silent refresh, sign-out with revocation, a `/me` identity probe for
 * the browser, and a same-origin `/proxy` so `createKortix` in the browser
 * talks to Kortix AS the signed-in viewer without ever holding a token.
 *
 * Framework-free on purpose: only Web `Request`/`Response`, `URL`, `fetch` and
 * WebCrypto (`crypto.subtle`) — present in Node ≥ 19, Bun, Deno and every edge
 * runtime. No `node:` import beyond what `./server` already carries for
 * `createScopedKortix`. Works identically against kortix.com and a self-host;
 * the only Kortix-specific inputs are `backendUrl` and a registered client
 * (`kortix.iam.oauthClients.create`, or Account → Tokens → OAuth apps).
 *
 * Server-side state is the cookie. `viewer()` is read-only and never consumes
 * the (single-use, rotating) refresh token; the `/refresh`, `/me` and `/proxy`
 * paths — which return a `Response` and can set cookies — are the only places
 * a rotation is persisted. `requireViewer()` turns an expired session into a
 * redirect through `/refresh`, so a page never renders "signed out" for a user
 * whose refresh token is still good.
 */
import { createScopedKortix, forwardKortixRequest } from './server';
import type { Kortix } from '../core/client/kortix';
import type { AccountIdentity } from '../core/rest/projects-client/accounts';
import { stripTrailingSlashes } from '../platform/strings';

/** The subset of `fetch` the kit needs — assignable from any fetch-shaped function. */
export type KortixFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface KortixAuthOptions {
  /** Kortix API base incl. version prefix, e.g. `https://api.kortix.com/v1`. */
  backendUrl: string;
  /** The OAuth client id from Account → Tokens → OAuth apps. */
  clientId: string;
  /** The client secret. Omit for a `public` client (PKCE only). */
  clientSecret?: string;
  /** Absolute callback URL, byte-identical to one registered on the client. */
  redirectUri: string;
  /** ≥ 32 characters. Encrypts the session cookie (AES-256-GCM, key = SHA-256 of this). */
  cookieSecret: string;
  /** Scopes to request. Default: `profile email kortix` (`kortix` = act as the user on the API). */
  scopes?: string[];
  /** Mount path of `handler()`. Default: the redirect URI's path minus `/callback`. */
  basePath?: string;
  /** How long a signed-in session may live without a fresh sign-in. Default 30 days (the refresh-token lifetime). */
  sessionTtlSeconds?: number;
  /** Custom `fetch` (tests, edge adapters). */
  fetch?: KortixFetch;
  /** Clock, for tests. */
  now?: () => number;
}

export interface KortixViewer {
  userId: string;
  email: string;
  accounts: AccountIdentity['accounts'];
  /** Scopes the user granted this app. */
  scopes: string[];
  /** The viewer's access token — pass it to `createScopedKortix` or send it as a bearer. */
  token: string;
  /** Epoch milliseconds when `token` expires. */
  expiresAt: number;
}

export type RequireViewerResult =
  | { viewer: KortixViewer; response?: undefined }
  | { viewer?: undefined; response: Response };

export interface KortixAuth {
  /** The mount path every link and cookie assumes (e.g. `/api/kortix/auth`). */
  readonly basePath: string;
  /**
   * The one route. Mount it as a catch-all under `basePath` for every method:
   * `/signin`, `/callback`, `/refresh`, `/signout`, `/me`, `/proxy/*`.
   */
  handler(request: Request): Promise<Response>;
  /** The signed-in viewer, or `null`. Read-only: never rotates a refresh token. */
  viewer(request: Request): Promise<KortixViewer | null>;
  /** The viewer, or the redirect (`/refresh` when refreshable, else `/signin`) to return from middleware. */
  requireViewer(request: Request): Promise<RequireViewerResult>;
  /** A request-scoped SDK client acting as the viewer. Throws `KortixAuthError` when signed out. */
  kortix(request: Request): Promise<Kortix>;
  /** Link target that starts sign-in and returns to `returnTo` (a same-origin path). */
  signInUrl(returnTo?: string): string;
  /** Link target that signs out and lands on `returnTo`. */
  signOutUrl(returnTo?: string): string;
  /**
   * `createKortix` config for the browser: `backendUrl` is this app's
   * `/proxy`, and `getToken` yields a sentinel the proxy swaps for the
   * viewer's real token. `origin` defaults to `window.location.origin`.
   */
  clientConfig(origin?: string): { backendUrl: string; getToken: () => Promise<string> };
  /** @internal test seam */
  __setNow(now: () => number): void;
}

export class KortixAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_options'
      | 'unauthenticated'
      | 'state_mismatch'
      | 'token_exchange_failed'
      | 'refresh_failed',
    message: string,
  ) {
    super(message);
    this.name = 'KortixAuthError';
  }
}

/** The bearer the browser sends; `/proxy` replaces it with the viewer's token. */
export const KORTIX_SESSION_SENTINEL = 'kortix-session';

const DEFAULT_SCOPES = ['profile', 'email', 'kortix'];
const TXN_TTL_S = 10 * 60;
const DEFAULT_SESSION_TTL_S = 30 * 24 * 3600;
/** Treat a token as expired this long before Kortix does, so a call in flight never lands on a dead token. */
const EXPIRY_SKEW_S = 30;

// ─── small codecs ────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const s = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

function randomB64url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

async function sha256B64url(input: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(value: unknown, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

async function open<T>(token: string, secret: string): Promise<T | null> {
  const [ivPart, ctPart, extra] = token.split('.');
  if (!ivPart || !ctPart || extra) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(ivPart) },
      await aesKey(secret),
      fromB64url(ctPart),
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

/** Only a same-origin path may be a post-auth destination. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

// ─── payloads ────────────────────────────────────────────────────────────────

interface TxnPayload {
  v: 1;
  state: string;
  verifier: string;
  returnTo: string;
  exp: number; // epoch seconds
}

interface SessionPayload {
  v: 1;
  at: string;
  rt: string;
  /** Access-token expiry, epoch seconds. */
  exp: number;
  scopes: string[];
}

// ─── the kit ─────────────────────────────────────────────────────────────────

export function createKortixAuth(options: KortixAuthOptions): KortixAuth {
  if (!options.cookieSecret || options.cookieSecret.length < 32) {
    throw new KortixAuthError('invalid_options', 'cookieSecret must be at least 32 characters');
  }
  let redirect: URL;
  try {
    redirect = new URL(options.redirectUri);
  } catch {
    throw new KortixAuthError('invalid_options', 'redirectUri must be an absolute URL');
  }
  if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') {
    throw new KortixAuthError('invalid_options', 'redirectUri must be http(s)');
  }
  if (!options.clientId) throw new KortixAuthError('invalid_options', 'clientId is required');
  if (!options.backendUrl) throw new KortixAuthError('invalid_options', 'backendUrl is required');

  const backendUrl = stripTrailingSlashes(options.backendUrl);
  const rawBase = options.basePath ?? (redirect.pathname.endsWith('/callback/') ? redirect.pathname.slice(0, -'/callback/'.length) : redirect.pathname.endsWith('/callback') ? redirect.pathname.slice(0, -'/callback'.length) : redirect.pathname);
  const basePath = stripTrailingSlashes(rawBase) || '/';
  const secure = redirect.protocol === 'https:';
  const sessionCookie = secure ? '__Host-kortix_session' : 'kortix_session';
  const txnCookie = secure ? '__Host-kortix_oauth_txn' : 'kortix_oauth_txn';
  const scopes = options.scopes?.length ? options.scopes : DEFAULT_SCOPES;
  const sessionTtl = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_S;
  const fetchImpl: KortixFetch = options.fetch ?? ((input, init) => fetch(input, init));
  let now = options.now ?? (() => Date.now());
  const nowS = () => Math.floor(now() / 1000);

  const cookieLine = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearLine = (name: string) => cookieLine(name, '', 0);

  const redirectTo = (location: string, cookies: string[] = []): Response => {
    const headers = new Headers({ location, 'cache-control': 'no-store' });
    for (const c of cookies) headers.append('set-cookie', c);
    return new Response(null, { status: 302, headers });
  };
  const jsonResponse = (body: unknown, status = 200, cookies: string[] = []): Response => {
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    for (const c of cookies) headers.append('set-cookie', c);
    return new Response(JSON.stringify(body), { status, headers });
  };

  const pathOf = (request: Request) => {
    const url = new URL(request.url);
    return `${url.pathname}${url.search}`;
  };
  const signInUrl = (returnTo?: string) =>
    returnTo ? `${basePath}/signin?return_to=${encodeURIComponent(safeReturnTo(returnTo))}` : `${basePath}/signin`;
  const signOutUrl = (returnTo?: string) =>
    returnTo ? `${basePath}/signout?return_to=${encodeURIComponent(safeReturnTo(returnTo))}` : `${basePath}/signout`;
  const refreshUrl = (returnTo: string) => `${basePath}/refresh?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`;

  // ── Kortix calls ──
  const clientAuthFields = () => ({
    client_id: options.clientId,
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
  });

  async function tokenRequest(fields: Record<string, string>): Promise<
    | { ok: true; session: SessionPayload }
    | { ok: false; status: number; error: string; description?: string }
  > {
    let res: Response;
    try {
      res = await fetchImpl(`${backendUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...fields, ...clientAuthFields() }).toString(),
      });
    } catch (err) {
      return { ok: false, status: 502, error: 'upstream_unreachable', description: (err as Error).message };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
      return {
        ok: false,
        status: res.status,
        error: typeof body.error === 'string' ? body.error : 'token_error',
        description: typeof body.error_description === 'string' ? body.error_description : undefined,
      };
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    return {
      ok: true,
      session: {
        v: 1,
        at: body.access_token,
        rt: body.refresh_token,
        exp: nowS() + expiresIn,
        scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : scopes,
      },
    };
  }

  async function revoke(token: string): Promise<void> {
    try {
      await fetchImpl(`${backendUrl}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ token, ...clientAuthFields() }).toString(),
      });
    } catch {
      // Best effort: the cookie is cleared regardless; the token dies at its TTL.
    }
  }

  async function identity(token: string): Promise<AccountIdentity | null> {
    try {
      const res = await fetchImpl(`${backendUrl}/accounts/me`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!res.ok) return null;
      return (await res.json()) as AccountIdentity;
    } catch {
      return null;
    }
  }

  // ── session cookie ──
  const readSession = async (request: Request): Promise<SessionPayload | null> => {
    const raw = readCookie(request, sessionCookie);
    if (!raw) return null;
    const payload = await open<SessionPayload>(raw, options.cookieSecret);
    return payload && payload.v === 1 && typeof payload.at === 'string' && typeof payload.rt === 'string' ? payload : null;
  };
  const isLive = (s: SessionPayload) => s.exp - EXPIRY_SKEW_S > nowS();
  const sessionCookieLine = async (s: SessionPayload) => cookieLine(sessionCookie, await seal(s, options.cookieSecret), sessionTtl);

  const toViewer = (s: SessionPayload, id: AccountIdentity): KortixViewer => ({
    userId: id.user_id,
    email: id.email,
    accounts: id.accounts ?? [],
    scopes: s.scopes,
    token: s.at,
    expiresAt: s.exp * 1000,
  });

  /**
   * A live session, refreshing (and persisting via `setCookie`) when the access
   * token is expired but the refresh token may still be good. Used by the paths
   * that return a Response; `viewer()` deliberately does not go through here.
   */
  async function liveSession(
    request: Request,
  ): Promise<{ session: SessionPayload; setCookie: string | null } | null> {
    const session = await readSession(request);
    if (!session) return null;
    if (isLive(session)) return { session, setCookie: null };
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.rt });
    if (!refreshed.ok) return null;
    return { session: refreshed.session, setCookie: await sessionCookieLine(refreshed.session) };
  }

  // ── route handlers ──
  async function handleSignIn(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const returnTo = safeReturnTo(url.searchParams.get('return_to'));
    const state = randomB64url(24);
    const verifier = randomB64url(48);
    const challenge = await sha256B64url(verifier);
    const txn: TxnPayload = { v: 1, state, verifier, returnTo, exp: nowS() + TXN_TTL_S };
    const authorize = new URL(`${backendUrl}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', options.clientId);
    authorize.searchParams.set('redirect_uri', options.redirectUri);
    authorize.searchParams.set('scope', scopes.join(' '));
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    return redirectTo(authorize.toString(), [cookieLine(txnCookie, await seal(txn, options.cookieSecret), TXN_TTL_S)]);
  }

  async function handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rawTxn = readCookie(request, txnCookie);
    const txn = rawTxn ? await open<TxnPayload>(rawTxn, options.cookieSecret) : null;
    const state = url.searchParams.get('state') ?? '';
    if (!txn || txn.v !== 1 || txn.exp <= nowS() || !state || state !== txn.state) {
      return jsonResponse(
        { error: 'state_mismatch', error_description: 'The sign-in transaction is missing, expired, or does not match this callback.' },
        400,
        [clearLine(txnCookie)],
      );
    }
    const returnTo = safeReturnTo(txn.returnTo);
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      const target = new URL(returnTo, 'http://local');
      target.searchParams.set('kortix_auth_error', oauthError);
      return redirectTo(`${target.pathname}${target.search}`, [clearLine(txnCookie)]);
    }
    const code = url.searchParams.get('code') ?? '';
    if (!code) return jsonResponse({ error: 'invalid_callback', error_description: 'Missing code' }, 400, [clearLine(txnCookie)]);
    const exchanged = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      code_verifier: txn.verifier,
    });
    if (!exchanged.ok) {
      return jsonResponse(
        { error: 'token_exchange_failed', upstream_error: exchanged.error, error_description: exchanged.description ?? null },
        exchanged.status === 502 ? 502 : 400,
        [clearLine(txnCookie)],
      );
    }
    return redirectTo(returnTo, [await sessionCookieLine(exchanged.session), clearLine(txnCookie)]);
  }

  async function handleRefresh(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const returnTo = safeReturnTo(url.searchParams.get('return_to'));
    const session = await readSession(request);
    if (!session) return redirectTo(signInUrl(returnTo), [clearLine(sessionCookie)]);
    if (isLive(session)) return redirectTo(returnTo);
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.rt });
    if (!refreshed.ok) return redirectTo(signInUrl(returnTo), [clearLine(sessionCookie)]);
    return redirectTo(returnTo, [await sessionCookieLine(refreshed.session)]);
  }

  async function handleSignOut(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const returnTo = safeReturnTo(url.searchParams.get('return_to'));
    const session = await readSession(request);
    if (session) await revoke(session.rt);
    return redirectTo(returnTo, [clearLine(sessionCookie), clearLine(txnCookie)]);
  }

  async function handleMe(request: Request): Promise<Response> {
    const live = await liveSession(request);
    if (!live) return jsonResponse({ error: 'unauthenticated' }, 401, [clearLine(sessionCookie)]);
    const id = await identity(live.session.at);
    if (!id) return jsonResponse({ error: 'unauthenticated' }, 401, [clearLine(sessionCookie)]);
    const viewer = toViewer(live.session, id);
    return jsonResponse(
      { user_id: viewer.userId, email: viewer.email, accounts: viewer.accounts, scopes: viewer.scopes, expires_at: new Date(viewer.expiresAt).toISOString() },
      200,
      live.setCookie ? [live.setCookie] : [],
    );
  }

  async function handleProxy(request: Request, rest: string): Promise<Response> {
    const live = await liveSession(request);
    if (!live) return jsonResponse({ error: 'unauthenticated', error_description: 'Sign in with Kortix first.' }, 401);
    const url = new URL(request.url);
    const upstream = await forwardKortixRequest({
      request,
      upstreamUrl: `${backendUrl}/${rest.replace(/^\/+/, '')}${url.search}`,
      token: live.session.at,
      fetch: fetchImpl,
    });
    if (!live.setCookie) return upstream;
    const headers = new Headers(upstream.headers);
    headers.append('set-cookie', live.setCookie);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return jsonResponse({ error: 'not_found', error_description: `Not under ${basePath}` }, 404);
    }
    const sub = url.pathname.slice(basePath.length).replace(/^\/+/, '');
    const [head, ...tail] = sub.split('/');
    switch (head) {
      case 'signin':
        return handleSignIn(request);
      case 'callback':
        return handleCallback(request);
      case 'refresh':
        return handleRefresh(request);
      case 'signout':
        return handleSignOut(request);
      case 'me':
        return handleMe(request);
      case 'proxy':
        return handleProxy(request, tail.join('/'));
      default:
        return jsonResponse({ error: 'not_found' }, 404);
    }
  }

  async function viewer(request: Request): Promise<KortixViewer | null> {
    const session = await readSession(request);
    if (!session || !isLive(session)) return null;
    const id = await identity(session.at);
    return id ? toViewer(session, id) : null;
  }

  async function requireViewer(request: Request): Promise<RequireViewerResult> {
    const current = await viewer(request);
    if (current) return { viewer: current };
    const returnTo = pathOf(request);
    const session = await readSession(request);
    if (session && !isLive(session)) return { response: redirectTo(refreshUrl(returnTo)) };
    return { response: redirectTo(signInUrl(returnTo)) };
  }

  async function kortix(request: Request): Promise<Kortix> {
    const current = await viewer(request);
    if (!current) throw new KortixAuthError('unauthenticated', 'No signed-in Kortix viewer on this request');
    const token = current.token;
    return createScopedKortix({ backendUrl, getToken: async () => token, fetch: fetchImpl, clientSource: 'web' });
  }

  return {
    basePath,
    handler,
    viewer,
    requireViewer,
    kortix,
    signInUrl,
    signOutUrl,
    clientConfig(origin?: string) {
      const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
      return { backendUrl: `${stripTrailingSlashes(base)}${basePath}/proxy`, getToken: async () => KORTIX_SESSION_SENTINEL };
    },
    __setNow(next) {
      now = next;
    },
  };
}
