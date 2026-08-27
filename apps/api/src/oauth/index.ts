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
import { eq, and, inArray, isNull, lt, or } from 'drizzle-orm';
import { db } from '../shared/db';
import { randomAlphanumeric, verifySecretKey } from '../shared/crypto';
import { hashOauthToken, oauthTokenHashCandidates } from './token-hash';
import { supabaseAuth } from '../middleware/auth';
import { config } from '../config';
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
import { oauthAuthorizationServerMetadata } from './discovery';
import { isOAuthAccessToken, isOAuthRefreshToken, OAUTH_SCOPE_EMAIL, OAUTH_SCOPE_PROFILE } from './access-token';

// ─── Rate Limiter (in-memory, per client_id) ────────────────────────────────

const TOKEN_RATE_LIMIT = 20;
const TOKEN_RATE_WINDOW_MS = 60_000;
const tokenRateMap = new Map<string, number[]>();

function checkTokenRateLimit(clientId: string): boolean {
  const now = Date.now();
  const timestamps = tokenRateMap.get(clientId) ?? [];
  const recent = timestamps.filter((t) => now - t < TOKEN_RATE_WINDOW_MS);
  if (recent.length >= TOKEN_RATE_LIMIT) {
    tokenRateMap.set(clientId, recent);
    return false;
  }
  recent.push(now);
  tokenRateMap.set(clientId, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of tokenRateMap) {
    const recent = timestamps.filter((t) => now - t < TOKEN_RATE_WINDOW_MS);
    if (recent.length === 0) tokenRateMap.delete(key);
    else tokenRateMap.set(key, recent);
  }
}, 5 * 60_000).unref?.();

// ─── OAuth Access Token Middleware (userinfo only) ───────────────────────────

async function oauthTokenAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice(7);
  if (!token) throw new HTTPException(401, { message: 'Missing token' });

  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(
      and(
        inArray(oauthAccessTokens.tokenHash, oauthTokenHashCandidates(token)),
        isNull(oauthAccessTokens.revokedAt),
      ),
    )
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

/** A client_id is a uuid column; gate junk before it reaches Postgres (22P02 → 500). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClientRow = typeof oauthClients.$inferSelect;

async function loadActiveClient(clientId: string): Promise<ClientRow | null> {
  if (!UUID_REGEX.test(clientId)) return null;
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

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

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

/** Housekeeping: drop expired or consumed requests older than the TTL. */
export async function sweepExpiredAuthorizationRequests(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - AUTH_REQUEST_TTL_MS);
  await db
    .delete(oauthAuthorizationRequests)
    .where(or(lt(oauthAuthorizationRequests.expiresAt, now), lt(oauthAuthorizationRequests.createdAt, cutoff)));
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
      tokenHash: hashOauthToken(accessToken),
      clientId: params.clientId,
      userId: params.userId,
      accountId: params.accountId,
      scopes: params.scopes,
      expiresAt: accessExpiresAt,
    })
    .returning();

  await db.insert(oauthRefreshTokens).values({
    tokenHash: hashOauthToken(refreshToken),
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

    if (!clientId || !redirectUri || responseType !== 'code' || !codeChallenge) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing required parameters: client_id, redirect_uri, response_type=code, code_challenge',
        },
        400,
      );
    }
    if (codeChallengeMethod !== 'S256') {
      return c.json({ error: 'invalid_request', error_description: 'Only code_challenge_method=S256 is supported' }, 400);
    }

    const client = await loadActiveClient(clientId);
    if (!client) {
      return c.json({ error: 'invalid_client', error_description: 'Client not found or inactive' }, 400);
    }

    const allowedUris = client.redirectUris ?? [];
    if (!parseRedirectUri(redirectUri) || !allowedUris.includes(redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri not in allowed list' }, 400);
    }
    const scopes = validateRequestedScopes(parseScopeList(scope), client.scopes);
    if (!scopes) return c.json({ error: 'invalid_scope' }, 400);

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
  if (authCode.usedAt) return c.json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, 400);
  if (authCode.expiresAt < new Date()) return c.json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400);
  if (authCode.redirectUri !== redirectUri) return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);

  const computedBuf = Buffer.from(computeCodeChallenge(codeVerifier));
  const storedBuf = Buffer.from(authCode.codeChallenge);
  if (computedBuf.length !== storedBuf.length || !timingSafeEqual(computedBuf, storedBuf)) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
  }

  const [consumedCode] = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthAuthorizationCodes.id, authCode.id), isNull(oauthAuthorizationCodes.usedAt)))
    .returning();
  if (!consumedCode) return c.json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, 400);

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

  const [refreshRow] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(
      and(
        inArray(oauthRefreshTokens.tokenHash, oauthTokenHashCandidates(refreshTokenRaw)),
        eq(oauthRefreshTokens.clientId, client.clientId),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!refreshRow) return c.json({ error: 'invalid_grant', error_description: 'Refresh token not found or revoked' }, 400);
  if (refreshRow.expiresAt < new Date()) return c.json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400);

  const now = new Date();
  const [consumedRefresh] = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshTokens.id, refreshRow.id), isNull(oauthRefreshTokens.revokedAt)))
    .returning();
  if (!consumedRefresh) return c.json({ error: 'invalid_grant', error_description: 'Refresh token already used' }, 400);

  await db.update(oauthAccessTokens).set({ revokedAt: now }).where(eq(oauthAccessTokens.id, refreshRow.accessTokenId));

  const [oldAccess] = await db
    .select({ scopes: oauthAccessTokens.scopes })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.id, refreshRow.accessTokenId))
    .limit(1);

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
      const rows = await db
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(oauthRefreshTokens.tokenHash, oauthTokenHashCandidates(token)),
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
      const rows = await db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(oauthAccessTokens.tokenHash, oauthTokenHashCandidates(token)),
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

    const { getSupabase } = await import('../shared/supabase');
    const {
      data: { user },
    } = await getSupabase().auth.admin.getUserById(userId);

    return c.json({ sub: userId, user_id: userId, account_id: accountId, email: user?.email ?? '' });
  },
);
