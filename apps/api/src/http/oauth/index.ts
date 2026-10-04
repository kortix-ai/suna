/**
 * Kortix as an OAuth 2.1 authorization server — "Sign in with Kortix".
 *
 * A registered client (see ../accounts/iam/oauth-clients.ts) sends a user to
 * `/authorize`; the pending request is persisted, the user approves on the
 * web consent screen (or is waved through by a remembered consent), the
 * client exchanges the code at `/token` with PKCE, and the resulting
 * `kortix_oat_` token acts as the user on the whole API when the `kortix`
 * scope was granted (see ./access-token.ts).
 *
 * Confidential clients present `client_secret`; public clients (a browser or
 * native app) rely on PKCE alone and must not send a secret.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { eq, and, desc, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../lib/db';
import { hashSecretKey, randomAlphanumeric, verifySecretKey } from '../../lib/crypto';
import { hashSecretKeyAsync } from '../../services/auth/token-hash';
import { supabaseAuth } from '../middleware/auth';
import { config } from '../../lib/config';
import {
  oauthClients,
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthAccessTokens,
  oauthConsents,
  oauthRefreshTokens,
  accountMembers,
} from '@kortix/db';
import { makeOpenApiApp, json, errors, auth } from '../openapi';
import { isMcpResource, oauthAuthorizationServerMetadata, oauthIssuer } from '../../services/oauth/discovery';
import { createOAuthClient, normalizeRedirectUris, OAuthClientInputError } from '../../services/repositories/oauth-clients';
import { TokenBucketRateLimiter } from '../middleware/rate-limit';
import { requestClientKey } from '../lib/client-ip';
import { isOAuthAccessToken, isOAuthRefreshToken, isOAuthScope, OAUTH_SCOPE_EMAIL, OAUTH_SCOPE_KORTIX, OAUTH_SCOPE_PROFILE } from '../../services/oauth/access-token';
import { isUuid } from '../../lib/validate';
import { actsAsFullIdentity } from '../accounts/core/tokens';
import { actorOf } from '../middleware/actor';
import { resolveAccountId } from '../../services/accounts/resolve-account';
import { AUTH_REQUEST_TTL_MS, SELF_REGISTERED_DESCRIPTION } from '../../services/oauth/requests';

// ─── Rate Limiter (per client_id) ───────────────────────────────────────────

// replica-local: the bucket lives in this process, so the fleet allows
// 20/min × replicas. It stops runaway clients; it does not meter a quota.
const tokenRateLimiter = new TokenBucketRateLimiter('oauth_token');

function checkTokenRateLimit(clientId: string): boolean {
  return tokenRateLimiter.check(clientId, { limit: 20, windowMs: 60_000 }).allowed;
}

// ─── OAuth Access Token Middleware (userinfo only) ───────────────────────────

async function oauthTokenAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice(7);
  if (!token) throw new HTTPException(401, { message: 'Missing token' });

  const tokenHash = await hashSecretKeyAsync(token);
  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.tokenHash, tokenHash), isNull(oauthAccessTokens.revokedAt)))
    .limit(1);
  if (!row) throw new HTTPException(401, { message: 'Invalid access token' });
  if (row.expiresAt < new Date()) throw new HTTPException(401, { message: 'Access token expired' });

  c.set('oauthUserId', row.userId);
  c.set('oauthAccountId', row.accountId);
  c.set('oauthClientId', row.clientId);
  c.set('oauthScopes', row.scopes ?? []);
  await next();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function parseRedirectUri(value: string): URL | null {
  try {
    const url = new URL(value);
    if (['javascript:', 'data:', 'vbscript:', 'file:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function parseScopeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim()))
      .map((scope) => scope.trim());
  }
  if (typeof value !== 'string') return [];
  return value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

function validateRequestedScopes(requested: string[], allowed: unknown): string[] | null {
  const allowedSet = new Set(parseScopeList(allowed));
  for (const scope of requested) {
    if (!allowedSet.has(scope)) return null;
  }
  return requested;
}

function requireOAuthScope(c: Context, scopes: string[]): Response | null {
  const granted = ((c as any).get('oauthScopes') as string[] | undefined) ?? [];
  return scopes.some((scope) => granted.includes(scope))
    ? null
    : c.json({ error: 'insufficient_scope', required_scope: scopes.join(' | ') }, 403);
}

type ClientRow = typeof oauthClients.$inferSelect;

/** A client_id is a uuid column; gate junk before it reaches Postgres (22P02 → 500). */
async function loadActiveClient(clientId: string): Promise<ClientRow | null> {
  if (!isUuid(clientId)) return null;
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.active, true)))
    .limit(1);
  return client ?? null;
}

function isPublicClient(client: ClientRow): boolean {
  return (client as { clientType?: string }).clientType === 'public';
}

/**
 * Client authentication at /token and /revoke. A confidential client must
 * present its secret; a public client must NOT (a secret it "has" is a secret
 * everyone has, and accepting one would let a leaked value look like proof).
 */
function authenticateClient(client: ClientRow, clientSecret: string | undefined): boolean {
  if (isPublicClient(client)) return !clientSecret;
  if (!clientSecret) return false;
  return verifySecretKey(clientSecret, client.clientSecretHash);
}

// ─── Pending authorization requests (persisted) ─────────────────────────────


function hashRequestId(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex');
}

type PendingAuthorizationRequest = {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
};

async function createAuthorizationRequest(request: Omit<PendingAuthorizationRequest, 'id'>): Promise<string> {
  const requestId = randomBytes(32).toString('base64url');
  await db.insert(oauthAuthorizationRequests).values({
    requestIdHash: hashRequestId(requestId),
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    state: request.state,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
  });
  return requestId;
}

async function getAuthorizationRequest(requestId: string): Promise<PendingAuthorizationRequest | null> {
  const [row] = await db
    .select()
    .from(oauthAuthorizationRequests)
    .where(
      and(
        eq(oauthAuthorizationRequests.requestIdHash, hashRequestId(requestId)),
        isNull(oauthAuthorizationRequests.consumedAt),
      ),
    )
    .limit(1);
  if (!row || row.expiresAt < new Date()) return null;
  return {
    id: row.id,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    scopes: (row.scopes as string[] | null) ?? [],
    state: row.state ?? '',
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
  };
}

/** Atomic consume: the row flips once, so a replayed decision is a 400. */
async function consumeAuthorizationRequest(requestId: string): Promise<PendingAuthorizationRequest | null> {
  const [row] = await db
    .update(oauthAuthorizationRequests)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationRequests.requestIdHash, hashRequestId(requestId)),
        isNull(oauthAuthorizationRequests.consumedAt),
      ),
    )
    .returning();
  if (!row || row.expiresAt < new Date()) return null;
  return {
    id: row.id,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    scopes: (row.scopes as string[] | null) ?? [],
    state: row.state ?? '',
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
  };
}

// ─── Remembered consent ─────────────────────────────────────────────────────

async function rememberedScopes(userId: string, clientId: string): Promise<string[] | null> {
  const [row] = await db
    .select({ scopes: oauthConsents.scopes })
    .from(oauthConsents)
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)))
    .limit(1);
  return row ? ((row.scopes as string[] | null) ?? []) : null;
}

function consentCovers(remembered: string[] | null, requested: string[]): boolean {
  if (!remembered) return false;
  return requested.every((scope) => remembered.includes(scope));
}

async function rememberConsent(userId: string, clientId: string, scopes: string[]): Promise<void> {
  const existing = await rememberedScopes(userId, clientId);
  const merged = Array.from(new Set([...(existing ?? []), ...scopes]));
  await db
    .insert(oauthConsents)
    .values({ userId, clientId, scopes: merged, grantedAt: new Date() })
    .onConflictDoUpdate({
      target: [oauthConsents.userId, oauthConsents.clientId],
      set: { scopes: merged, grantedAt: new Date() },
    });
}

// ─── Token Generation ───────────────────────────────────────────────────────

function generateAccessToken(): string {
  return `kortix_oat_${randomAlphanumeric(48)}`;
}

function generateRefreshToken(): string {
  return `kortix_ort_${randomAlphanumeric(48)}`;
}

function generateAuthCode(): string {
  return randomBytes(48).toString('hex');
}

export const OAUTH_ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

async function issueTokenPair(params: { clientId: string; userId: string; accountId: string; scopes: string[] }) {
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + OAUTH_ACCESS_TOKEN_TTL_S * 1000);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  const [accessRow] = await db
    .insert(oauthAccessTokens)
    .values({
      tokenHash: hashSecretKey(accessToken),
      clientId: params.clientId,
      userId: params.userId,
      accountId: params.accountId,
      scopes: params.scopes,
      expiresAt: accessExpiresAt,
    })
    .returning();

  await db.insert(oauthRefreshTokens).values({
    tokenHash: hashSecretKey(refreshToken),
    accessTokenId: accessRow.id,
    clientId: params.clientId,
    userId: params.userId,
    accountId: params.accountId,
    expiresAt: refreshExpiresAt,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer' as const,
    expires_in: OAUTH_ACCESS_TOKEN_TTL_S,
    scope: params.scopes.join(' '),
  };
}

// ─── Hono App ───────────────────────────────────────────────────────────────

export const oauthApp = makeOpenApiApp();

oauthApp.use('/authorize/consent/:requestId', supabaseAuth);
oauthApp.use('/authorize/consent', supabaseAuth);
oauthApp.use('/userinfo', oauthTokenAuth);
oauthApp.use('/grants', supabaseAuth);
oauthApp.use('/grants/*', supabaseAuth);

// ─── GET /.well-known/oauth-authorization-server (mirror) ───────────────────

oauthApp.openapi(
  createRoute({
    method: 'get',
    path: '/.well-known/oauth-authorization-server',
    tags: ['oauth'],
    summary: 'RFC 8414 authorization-server metadata (mirror of the API-root document)',
    responses: { 200: json(z.object({ issuer: z.string() }).passthrough(), 'Authorization server metadata') },
  }),
  async (c: any) => {
    const origin = new URL(c.req.url).origin;
    return c.json(oauthAuthorizationServerMetadata(origin), 200, {
      'cache-control': 'public, max-age=3600',
    });
  },
);

// ─── GET /authorize ─────────────────────────────────────────────────────────

oauthApp.openapi(
  createRoute({
    method: 'get',
    path: '/authorize',
    tags: ['oauth'],
    summary: 'OAuth 2.1 authorization endpoint (PKCE) — redirects to consent',
    request: {
      query: z.object({
        client_id: z.string().optional(),
        redirect_uri: z.string().optional(),
        response_type: z.string().optional(),
        scope: z.string().optional(),
        state: z.string().optional(),
        code_challenge: z.string().optional(),
        code_challenge_method: z.string().optional(),
        resource: z.string().optional(),
      }),
    },
    responses: {
      302: { description: 'Redirect to the consent screen' },
      ...errors(400),
    },
  }),
  async (c: any) => {
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const responseType = c.req.query('response_type');
    const scope = c.req.query('scope') ?? '';
    const state = c.req.query('state') ?? '';
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method') ?? 'S256';

    if (!clientId || !redirectUri) {
      return c.json({ error: 'invalid_request', error_description: 'Missing required parameters: client_id, redirect_uri' }, 400);
    }
    const client = await loadActiveClient(clientId);
    if (!client) {
      return c.json({ error: 'invalid_client', error_description: 'Client not found or inactive' }, 400);
    }
    const allowedUris = client.redirectUris ?? [];
    const back = parseRedirectUri(redirectUri);
    if (!back || !allowedUris.includes(redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri not in allowed list' }, 400);
    }
    // The redirect_uri is registered: every later failure goes back to the
    // client as `?error=` (RFC 6749 4.1.2.1), never as JSON in the browser.
    const fail = (error: string, description: string) => {
      back.searchParams.set('error', error);
      back.searchParams.set('error_description', description);
      if (state) back.searchParams.set('state', state);
      return c.redirect(back.toString());
    };
    if (responseType !== 'code' || !codeChallenge) {
      return fail('invalid_request', 'Missing required parameters: response_type=code, code_challenge');
    }
    if (codeChallengeMethod !== 'S256') {
      return fail('invalid_request', 'Only code_challenge_method=S256 is supported');
    }
    // RFC 8707 `resource`: the MCP URL or the API origin. A token is not
    // audience-bound, so any other target is refused rather than ignored.
    const resource = c.req.query('resource');
    const origin = new URL(c.req.url).origin;
    if (resource && !isMcpResource(resource, origin) && resource.replace(/\/+$/, '') !== oauthIssuer(origin)) {
      return fail('invalid_target', 'resource must be the Kortix MCP URL or the API origin');
    }
    // Unknown scopes (openid, offline_access, mcp:tools…) are ignored. None left
    // means the client's registered scopes: for an MCP client, `kortix`.
    const known = parseScopeList(scope).filter(isOAuthScope);
    const registered = parseScopeList(client.scopes);
    const scopes = validateRequestedScopes(known.length ? known : registered, client.scopes);
    if (!scopes) return fail('invalid_scope', 'The client is not registered for a requested scope');

    const requestId = await createAuthorizationRequest({
      clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge,
      codeChallengeMethod,
    });

    const frontendUrl = config.FRONTEND_URL || 'https://kortix.com';
    const consentUrl = new URL(`${frontendUrl.replace(/\/$/, '')}/oauth/authorize`);
    consentUrl.searchParams.set('request_id', requestId);
    return c.redirect(consentUrl.toString());
  },
);

// ─── GET /authorize/consent/:requestId ──────────────────────────────────────

oauthApp.openapi(
  createRoute({
    method: 'get',
    path: '/authorize/consent/{requestId}',
    tags: ['oauth'],
    summary: 'Fetch a pending authorization request for the consent screen',
    ...auth,
    request: { params: z.object({ requestId: z.string() }) },
    responses: {
      200: json(
        z.object({
          client_id: z.string(),
          client_name: z.string(),
          client_type: z.string(),
          scope: z.string(),
          scopes: z.array(z.string()),
          /** True when this user already approved this client for every requested scope — the UI approves without asking. */
          remembered: z.boolean(),
          /** True when the client registered itself (RFC 7591) — no account vouches for it. */
          self_registered: z.boolean(),
          /** Where the browser goes after approval: the origin, or the scheme of a native app. */
          redirect_to: z.string(),
        }),
        'The pending authorization request',
      ),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
    const requestId = c.req.param('requestId');
    if (!requestId) return c.json({ error: 'invalid_request', error_description: 'Missing request id' }, 400);
    const request = await getAuthorizationRequest(requestId);
    if (!request) {
      return c.json({ error: 'invalid_request', error_description: 'Authorization request expired or not found' }, 400);
    }
    const client = await loadActiveClient(request.clientId);
    if (!client) return c.json({ error: 'invalid_client' }, 400);
    const userId = (c as any).get('userId') as string;
    const remembered = consentCovers(await rememberedScopes(userId, request.clientId), request.scopes);
    return c.json({
      client_id: request.clientId,
      client_name: client.name,
      client_type: isPublicClient(client) ? 'public' : 'confidential',
      scope: request.scopes.join(' '),
      scopes: request.scopes,
      remembered,
      self_registered: isSelfRegistered(client),
      redirect_to: redirectTarget(request.redirectUri),
    });
  },
);

// ─── POST /authorize/consent ────────────────────────────────────────────────

oauthApp.openapi(
  createRoute({
    method: 'post',
    path: '/authorize/consent',
    tags: ['oauth'],
    summary: 'Approve or deny a pending authorization request',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ request_id: z.string().optional(), approved: z.boolean().optional() }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ redirect_uri: z.string() }), 'Redirect URI to send the user back to'),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
    const body = await c.req.json();
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const approved = body.approved === true;
    if (!requestId) return c.json({ error: 'invalid_request' }, 400);

    const request = await consumeAuthorizationRequest(requestId);
    if (!request) {
      return c.json({ error: 'invalid_request', error_description: 'Authorization request expired or already used' }, 400);
    }

    const client = await loadActiveClient(request.clientId);
    if (!client) return c.json({ error: 'invalid_client' }, 400);

    const allowedUris = client.redirectUris ?? [];
    const redirect = parseRedirectUri(request.redirectUri);
    if (!redirect || !allowedUris.includes(request.redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri mismatch' }, 400);
    }
    const scopes = validateRequestedScopes(request.scopes, client.scopes);
    if (!scopes) return c.json({ error: 'invalid_scope' }, 400);

    if (!approved) {
      redirect.searchParams.set('error', 'access_denied');
      if (request.state) redirect.searchParams.set('state', request.state);
      return c.json({ redirect_uri: redirect.toString() });
    }

    const userId = (c as any).get('userId') as string;
    const [membership] = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(eq(accountMembers.userId, userId))
      .limit(1);
    const accountId = membership?.accountId ?? userId;

    const code = generateAuthCode();
    await db.insert(oauthAuthorizationCodes).values({
      code,
      clientId: request.clientId,
      userId,
      accountId,
      redirectUri: request.redirectUri,
      scopes,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    await rememberConsent(userId, request.clientId, scopes);

    redirect.searchParams.set('code', code);
    if (request.state) redirect.searchParams.set('state', request.state);
    return c.json({ redirect_uri: redirect.toString() });
  },
);

// ─── POST /register (RFC 7591) ──────────────────────────────────────────────

/** Stored on a self-registered client; nothing else marks one. */

function isSelfRegistered(client: ClientRow): boolean {
  return client.accountId === null && client.description === SELF_REGISTERED_DESCRIPTION;
}

function redirectTarget(redirectUri: string): string {
  const url = parseRedirectUri(redirectUri);
  if (!url) return redirectUri;
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.protocol;
}

// replica-local: per-instance bucket; a shared store if registration spam spans instances.
const registerLimiter = new TokenBucketRateLimiter('oauth_register');
const REGISTER_POLICY = { limit: 30, windowMs: 60 * 60 * 1000 };

oauthApp.openapi(
  createRoute({
    method: 'post',
    path: '/register',
    tags: ['oauth'],
    summary: 'RFC 7591 dynamic client registration (public PKCE clients, e.g. MCP clients)',
    request: { body: { content: { 'application/json': { schema: z.any() } } } },
    responses: {
      201: json(z.object({ client_id: z.string() }).passthrough(), 'The registered client'),
      ...errors(400, 429),
    },
  }),
  async (c: any) => {
    const limit = registerLimiter.check(requestClientKey(c), REGISTER_POLICY);
    if (!limit.allowed) {
      return c.json({ error: 'rate_limit_exceeded', error_description: 'Too many registrations' }, 429, {
        'Retry-After': String(Math.ceil(limit.resetMs / 1000)),
      });
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Body must be a JSON object' }, 400);
    }
    const name =
      (typeof body.client_name === 'string' && body.client_name.trim().slice(0, 100)) || 'MCP client';
    let redirectUris: string[];
    let scopes: string[];
    try {
      redirectUris = normalizeRedirectUris(body.redirect_uris, { native: true });
      // Unknown scopes (openid, offline_access, mcp:tools…) are ignored; none left → kortix.
      scopes = [...new Set(parseScopeList(body.scope).filter(isOAuthScope))];
      if (scopes.length === 0) scopes = [OAUTH_SCOPE_KORTIX];
    } catch (err) {
      if (err instanceof OAuthClientInputError) {
        const error = /redirect_uri/.test(err.message) ? 'invalid_redirect_uri' : 'invalid_client_metadata';
        return c.json({ error, error_description: err.message }, 400);
      }
      throw err;
    }
    const created = await createOAuthClient({
      accountId: null,
      createdBy: null,
      name,
      description: SELF_REGISTERED_DESCRIPTION,
      clientType: 'public',
      redirectUris,
      scopes,
    });
    return c.json(
      {
        client_id: created.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: scopes.join(' '),
      },
      201,
    );
  },
);

// ─── POST /token ────────────────────────────────────────────────────────────

oauthApp.openapi(
  createRoute({
    method: 'post',
    path: '/token',
    tags: ['oauth'],
    summary: 'OAuth 2.1 token endpoint (authorization_code / refresh_token grants)',
    request: {
      body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
    },
    responses: {
      200: json(
        z
          .object({
            access_token: z.string(),
            refresh_token: z.string(),
            token_type: z.string(),
            expires_in: z.number(),
            scope: z.string(),
          })
          .passthrough(),
        'Token pair',
      ),
      ...errors(400, 401, 429),
    },
  }),
  async (c: any) => {
    const body = await c.req.parseBody();
    const grantType = body['grant_type'] as string;
    const clientId = body['client_id'] as string;
    const clientSecret = (body['client_secret'] as string | undefined) || undefined;

    if (!clientId) {
      return c.json({ error: 'invalid_request', error_description: 'Missing client_id' }, 400);
    }
    if (!checkTokenRateLimit(clientId)) {
      return c.json({ error: 'rate_limit_exceeded', error_description: 'Too many token requests' }, 429);
    }
    const client = await loadActiveClient(clientId);
    if (!client) return c.json({ error: 'invalid_client' }, 401);
    if (!authenticateClient(client, clientSecret)) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: isPublicClient(client)
            ? 'A public client must not send client_secret'
            : 'Missing or invalid client_secret',
        },
        401,
      );
    }

    if (grantType === 'authorization_code') return handleAuthorizationCodeGrant(c, body, client);
    if (grantType === 'refresh_token') return handleRefreshTokenGrant(c, body, client);
    return c.json({ error: 'unsupported_grant_type' }, 400);
  },
);

/**
 * Revoke every live refresh and access token of one person's grant to one
 * client. `since` limits it to tokens created at or after that instant.
 */
async function revokeClientTokens(userId: string, clientId: string, since?: Date): Promise<void> {
  const now = new Date();
  const sinceRefresh = since ? [gte(oauthRefreshTokens.createdAt, since)] : [];
  const sinceAccess = since ? [gte(oauthAccessTokens.createdAt, since)] : [];
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.clientId, clientId), isNull(oauthRefreshTokens.revokedAt), ...sinceRefresh));
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.clientId, clientId), isNull(oauthAccessTokens.revokedAt), ...sinceAccess));
}

/**
 * RFC 9700 4.14.2 grace: two processes that share one credential store race to
 * refresh, and the loser must not force a new sign-in. A rotated refresh token
 * presented again inside this window is honoured. Read per call so the test
 * profile can shorten it.
 */
function refreshGraceMs(): number {
  const raw = Number(process.env.KORTIX_OAUTH_REFRESH_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

/**
 * RFC 6749 4.1.2: a second exchange of a code means it leaked; revoke what the
 * first exchange issued. Tokens carry no code id (no migration), so this
 * revokes the client+user tokens created at or after the code was created.
 * That over-approximates only when the same person authorised the same client
 * again after this code, which is the safe direction.
 */
async function codeReused(c: Context, authCode: typeof oauthAuthorizationCodes.$inferSelect) {
  await revokeClientTokens(authCode.userId, authCode.clientId, authCode.createdAt);
  return c.json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, 400);
}

async function handleAuthorizationCodeGrant(c: Context, body: Record<string, any>, client: ClientRow) {
  const code = body['code'] as string;
  const redirectUri = body['redirect_uri'] as string;
  const codeVerifier = body['code_verifier'] as string;

  if (!code || !redirectUri || !codeVerifier) {
    return c.json({ error: 'invalid_request', error_description: 'Missing code, redirect_uri, or code_verifier' }, 400);
  }

  const [authCode] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(and(eq(oauthAuthorizationCodes.code, code), eq(oauthAuthorizationCodes.clientId, client.clientId)))
    .limit(1);

  if (!authCode) return c.json({ error: 'invalid_grant', error_description: 'Authorization code not found' }, 400);
  if (authCode.usedAt) return codeReused(c, authCode);
  if (authCode.expiresAt < new Date()) return c.json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400);
  if (authCode.redirectUri !== redirectUri) return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);

  // Burn the code before the PKCE compare: a wrong verifier spends the code, so
  // a guesser gets one try per code.
  const [consumedCode] = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthAuthorizationCodes.id, authCode.id), isNull(oauthAuthorizationCodes.usedAt)))
    .returning();
  if (!consumedCode) return codeReused(c, authCode);

  // RFC 7636 4.1: 43-128 unreserved characters.
  const computedBuf = Buffer.from(computeCodeChallenge(codeVerifier));
  const storedBuf = Buffer.from(authCode.codeChallenge);
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier) || computedBuf.length !== storedBuf.length || !timingSafeEqual(computedBuf, storedBuf)) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
  }

  return c.json(
    await issueTokenPair({
      clientId: client.clientId,
      userId: authCode.userId,
      accountId: authCode.accountId,
      scopes: (authCode.scopes as string[]) ?? [],
    }),
  );
}

async function handleRefreshTokenGrant(c: Context, body: Record<string, any>, client: ClientRow) {
  const refreshTokenRaw = body['refresh_token'] as string;
  if (!refreshTokenRaw) return c.json({ error: 'invalid_request', error_description: 'Missing refresh_token' }, 400);

  const refreshHash = await hashSecretKeyAsync(refreshTokenRaw);
  const [refreshRow] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(and(eq(oauthRefreshTokens.tokenHash, refreshHash), eq(oauthRefreshTokens.clientId, client.clientId)))
    .limit(1);
  if (!refreshRow) return c.json({ error: 'invalid_grant', error_description: 'Refresh token not found or revoked' }, 400);
  if (refreshRow.expiresAt < new Date()) return c.json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400);

  const [oldAccess] = await db
    .select({ scopes: oauthAccessTokens.scopes, revokedAt: oauthAccessTokens.revokedAt })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.id, refreshRow.accessTokenId))
    .limit(1);

  // Rotation consumes the refresh token atomically. A revoked row is either
  // rotated (rotation leaves its access token live) or explicitly revoked
  // (/revoke and /grants kill the access token too). The loser of a race sees
  // the winner's revokedAt and takes the rotated branch.
  const now = new Date();
  const [consumed] = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshTokens.id, refreshRow.id), isNull(oauthRefreshTokens.revokedAt)))
    .returning({ id: oauthRefreshTokens.id });
  if (!consumed) {
    const [current] = await db.select({ revokedAt: oauthRefreshTokens.revokedAt }).from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, refreshRow.id)).limit(1);
    const rotatedAt = current?.revokedAt ?? refreshRow.revokedAt;
    if (!rotatedAt || !oldAccess || oldAccess.revokedAt) {
      return c.json({ error: 'invalid_grant', error_description: 'Refresh token not found or revoked' }, 400);
    }
    if (now.getTime() - rotatedAt.getTime() > refreshGraceMs()) {
      // Reuse detection (RFC 9700 4.14.2): revoke the whole grant.
      await revokeClientTokens(refreshRow.userId, client.clientId);
      return c.json({ error: 'invalid_grant', error_description: 'Refresh token already used' }, 400);
    }
  }

  // The old access token is not revoked: it dies at its own expiry (at most
  // OAUTH_ACCESS_TOKEN_TTL_S), so a client whose refresh response was lost, or
  // a sibling process still holding it, keeps working. Explicit revocation and
  // reuse detection still kill it at once.
  return c.json(
    await issueTokenPair({
      clientId: client.clientId,
      userId: refreshRow.userId,
      accountId: refreshRow.accountId,
      scopes: (oldAccess?.scopes as string[]) ?? [],
    }),
  );
}

// ─── POST /revoke (RFC 7009) ────────────────────────────────────────────────

oauthApp.openapi(
  createRoute({
    method: 'post',
    path: '/revoke',
    tags: ['oauth'],
    summary: 'Revoke an access or refresh token (RFC 7009)',
    request: {
      body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ revoked: z.boolean() }), 'Always 200 once the client is authenticated, whether or not the token existed'),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
    const body = await c.req.parseBody();
    const clientId = body['client_id'] as string;
    const clientSecret = (body['client_secret'] as string | undefined) || undefined;
    const token = body['token'] as string;
    if (!clientId || !token) {
      return c.json({ error: 'invalid_request', error_description: 'Missing client_id or token' }, 400);
    }
    const client = await loadActiveClient(clientId);
    if (!client || !authenticateClient(client, clientSecret)) return c.json({ error: 'invalid_client' }, 401);

    const now = new Date();
    let revoked = false;
    if (isOAuthRefreshToken(token)) {
      const tokenHash = await hashSecretKeyAsync(token);
      const rows = await db
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthRefreshTokens.tokenHash, tokenHash),
            eq(oauthRefreshTokens.clientId, client.clientId),
            isNull(oauthRefreshTokens.revokedAt),
          ),
        )
        .returning({ accessTokenId: oauthRefreshTokens.accessTokenId });
      for (const row of rows) {
        await db.update(oauthAccessTokens).set({ revokedAt: now }).where(eq(oauthAccessTokens.id, row.accessTokenId));
      }
      revoked = rows.length > 0;
    } else if (isOAuthAccessToken(token)) {
      const tokenHash = await hashSecretKeyAsync(token);
      const rows = await db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthAccessTokens.tokenHash, tokenHash),
            eq(oauthAccessTokens.clientId, client.clientId),
            isNull(oauthAccessTokens.revokedAt),
          ),
        )
        .returning({ id: oauthAccessTokens.id });
      for (const row of rows) {
        await db
          .update(oauthRefreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(oauthRefreshTokens.accessTokenId, row.id), isNull(oauthRefreshTokens.revokedAt)));
      }
      revoked = rows.length > 0;
    }
    // RFC 7009 §2.2: an unknown token is still a 200 — the outcome the caller
    // wants (the token is not usable) already holds.
    return c.json({ revoked });
  },
);

// ─── GET /grants, DELETE /grants/:clientId — the apps a person approved ─────
//
// "Connected apps": every client the caller approved (a consent row) or that
// still holds a live token for them — MCP clients, "Sign in with Kortix" apps.
// Revoking one deletes the consent, so the app must ask again, and revokes its
// live access and refresh tokens, which stop working on their next request
// (the verifier reads the token row every time). Only a browser session or an
// unscoped personal access token may do either, the rule personal tokens
// follow: an app holding a kortix_oat_ token must not list or revoke the
// others.

const GrantSchema = z.object({
  client_id: z.string(),
  name: z.string(),
  client_type: z.string(),
  /** Registered by the app itself (RFC 7591): its name is its own claim. */
  self_registered: z.boolean(),
  /** Where the app sends you back after sign-in: identifies an unverified app. */
  redirect_hosts: z.array(z.string()),
  scopes: z.array(z.string()),
  granted_at: z.string().nullable(),
  /** When the app last got a token. A connected app refreshes about hourly while in use. */
  last_active_at: z.string().nullable(),
  /** Holds a live refresh or access token right now. */
  active: z.boolean(),
});

async function requireFullIdentity(c: Context): Promise<Response | null> {
  const userId = c.get('userId') as string;
  const actor = await actorOf(c, await resolveAccountId(userId));
  if (actsAsFullIdentity(c.get('authType') as string | undefined, actor)) return null;
  return c.json({ error: 'Connected apps are managed from a browser session or an unscoped personal access token.' }, 403);
}

oauthApp.openapi(
  createRoute({
    method: 'get',
    path: '/grants',
    tags: ['oauth'],
    summary: 'List the apps you approved (connected apps)',
    ...auth,
    responses: {
      200: json(z.object({ grants: z.array(GrantSchema) }), 'Connected apps, most recently active first'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const denied = await requireFullIdentity(c);
    if (denied) return denied;
    const userId = c.get('userId') as string;
    const now = new Date();
    const [consents, accessTokens, refreshTokens] = await Promise.all([
      db.select().from(oauthConsents).where(eq(oauthConsents.userId, userId)),
      db
        .select({ clientId: oauthAccessTokens.clientId, createdAt: oauthAccessTokens.createdAt, expiresAt: oauthAccessTokens.expiresAt, revokedAt: oauthAccessTokens.revokedAt })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.userId, userId))
        .orderBy(desc(oauthAccessTokens.createdAt)),
      db
        .select({ clientId: oauthRefreshTokens.clientId })
        .from(oauthRefreshTokens)
        .where(and(eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revokedAt), gt(oauthRefreshTokens.expiresAt, now))),
    ]);
    const live = new Set(refreshTokens.map((t) => t.clientId));
    const lastActive = new Map<string, Date>();
    for (const t of accessTokens) {
      if (!lastActive.has(t.clientId)) lastActive.set(t.clientId, t.createdAt);
      if (!t.revokedAt && t.expiresAt > now) live.add(t.clientId);
    }
    const consentByClient = new Map(consents.map((row) => [row.clientId, row]));
    // An app with neither a consent nor a live token is not connected: tokens
    // it held before a revoke stay in history, not in this list.
    const clientIds = [...new Set([...consentByClient.keys(), ...live])];
    if (clientIds.length === 0) return c.json({ grants: [] });
    const clients = await db.select().from(oauthClients).where(inArray(oauthClients.clientId, clientIds));
    const grants = clients.map((client) => {
      const consent = consentByClient.get(client.clientId);
      return {
        client_id: client.clientId,
        name: client.name,
        client_type: client.clientType,
        self_registered: isSelfRegistered(client),
        redirect_hosts: [...new Set(((client.redirectUris as string[] | null) ?? []).map(redirectTarget))],
        scopes: (consent?.scopes as string[] | null) ?? [],
        granted_at: consent?.grantedAt.toISOString() ?? null,
        last_active_at: lastActive.get(client.clientId)?.toISOString() ?? null,
        active: live.has(client.clientId),
      };
    });
    grants.sort((a, b) => (b.last_active_at ?? b.granted_at ?? '').localeCompare(a.last_active_at ?? a.granted_at ?? ''));
    return c.json({ grants });
  },
);

oauthApp.openapi(
  createRoute({
    method: 'delete',
    path: '/grants/{clientId}',
    tags: ['oauth'],
    summary: 'Revoke an app you approved: its consent and every live token it holds for you',
    ...auth,
    request: { params: z.object({ clientId: z.string() }) },
    responses: {
      200: json(z.object({ ok: z.literal(true), revoked_tokens: z.number() }), 'Revoked'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const clientId = c.req.param('clientId');
    if (!isUuid(clientId)) return c.json({ error: 'No connected app with that client_id' }, 404);
    const denied = await requireFullIdentity(c);
    if (denied) return denied;
    const userId = c.get('userId') as string;
    const now = new Date();
    // Every row is filtered by the caller's own user id: a client id alone
    // never reaches another person's grant.
    const [consents, refresh, access] = await db.transaction(async (tx) => [
      await tx
        .delete(oauthConsents)
        .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)))
        .returning({ id: oauthConsents.id }),
      await tx
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.clientId, clientId), isNull(oauthRefreshTokens.revokedAt), gt(oauthRefreshTokens.expiresAt, now)))
        .returning({ id: oauthRefreshTokens.id }),
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.clientId, clientId), isNull(oauthAccessTokens.revokedAt), gt(oauthAccessTokens.expiresAt, now)))
        .returning({ id: oauthAccessTokens.id }),
    ]);
    if (consents.length === 0 && refresh.length === 0 && access.length === 0) {
      return c.json({ error: 'No connected app with that client_id' }, 404);
    }
    return c.json({ ok: true as const, revoked_tokens: refresh.length + access.length });
  },
);

// ─── GET /userinfo ──────────────────────────────────────────────────────────

oauthApp.openapi(
  createRoute({
    method: 'get',
    path: '/userinfo',
    tags: ['oauth'],
    summary: 'OAuth userinfo (requires the `profile` or `email` scope)',
    ...auth,
    responses: {
      200: json(
        z.object({ sub: z.string(), user_id: z.string(), account_id: z.string(), email: z.string() }),
        'User info',
      ),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const scopeError = requireOAuthScope(c, [OAUTH_SCOPE_PROFILE, OAUTH_SCOPE_EMAIL]);
    if (scopeError) return scopeError;

    const userId = (c as any).get('oauthUserId') as string;
    const accountId = (c as any).get('oauthAccountId') as string;

    const { getSupabase } = await import('../../lib/supabase');
    const {
      data: { user },
    } = await getSupabase().auth.admin.getUserById(userId);

    return c.json({ sub: userId, user_id: userId, account_id: accountId, email: user?.email ?? '' });
  },
);
