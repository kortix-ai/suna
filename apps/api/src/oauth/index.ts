import { Hono } from 'hono';
import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { db } from '../shared/db';
import { randomAlphanumeric, verifySecretKey } from '../shared/crypto';
import { supabaseAuth } from '../middleware/auth';
import { config } from '../config';
import {
  oauthClients,
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  accountMembers,
  sandboxes,
} from '@kortix/db';

// ─── Token Hashing ──────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

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

// Periodic cleanup (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of tokenRateMap) {
    const recent = timestamps.filter((t) => now - t < TOKEN_RATE_WINDOW_MS);
    if (recent.length === 0) {
      tokenRateMap.delete(key);
    } else {
      tokenRateMap.set(key, recent);
    }
  }
}, 5 * 60_000);

// ─── OAuth Access Token Middleware ───────────────────────────────────────────

async function oauthTokenAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  if (!token) {
    throw new HTTPException(401, { message: 'Missing token' });
  }

  const tokenHash = hashToken(token);
  const now = new Date();

  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthAccessTokens.revokedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new HTTPException(401, { message: 'Invalid access token' });
  }

  if (row.expiresAt < now) {
    throw new HTTPException(401, { message: 'Access token expired' });
  }

  c.set('oauthUserId', row.userId);
  c.set('oauthAccountId', row.accountId);
  c.set('oauthClientId', row.clientId);
  c.set('oauthScopes', row.scopes ?? []);
  await next();
}

// ─── PKCE Helpers ───────────────────────────────────────────────────────────

function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
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
    return value.filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim())).map((scope) => scope.trim());
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

function requireOAuthScope(c: Context, scope: string): Response | null {
  const scopes = ((c as any).get('oauthScopes') as string[] | undefined) ?? [];
  return scopes.includes(scope)
    ? null
    : c.json({ error: 'insufficient_scope', required_scope: scope }, 403);
}

type PendingAuthorizationRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
};

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const pendingAuthorizationRequests = new Map<string, PendingAuthorizationRequest>();

function createAuthorizationRequest(request: Omit<PendingAuthorizationRequest, 'expiresAt'>): string {
  const requestId = randomBytes(32).toString('base64url');
  pendingAuthorizationRequests.set(requestId, {
    ...request,
    expiresAt: Date.now() + AUTH_REQUEST_TTL_MS,
  });
  return requestId;
}

function getAuthorizationRequest(requestId: string): PendingAuthorizationRequest | null {
  const request = pendingAuthorizationRequests.get(requestId);
  if (!request) return null;
  if (request.expiresAt < Date.now()) {
    pendingAuthorizationRequests.delete(requestId);
    return null;
  }
  return request;
}

function consumeAuthorizationRequest(requestId: string): PendingAuthorizationRequest | null {
  const request = getAuthorizationRequest(requestId);
  if (!request) return null;
  pendingAuthorizationRequests.delete(requestId);
  return request;
}

setInterval(() => {
  const now = Date.now();
  for (const [requestId, request] of pendingAuthorizationRequests) {
    if (request.expiresAt < now) pendingAuthorizationRequests.delete(requestId);
  }
}, 5 * 60_000);

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

// ─── Issue Token Pair ───────────────────────────────────────────────────────

async function issueTokenPair(params: {
  clientId: string;
  userId: string;
  accountId: string;
  scopes: string[];
}) {
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);

  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + 3600 * 1000);
  const refreshExpiresAt = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

  const [accessRow] = await db
    .insert(oauthAccessTokens)
    .values({
      tokenHash: accessTokenHash,
      clientId: params.clientId,
      userId: params.userId,
      accountId: params.accountId,
      scopes: params.scopes,
      expiresAt: accessExpiresAt,
    })
    .returning();

  await db.insert(oauthRefreshTokens).values({
    tokenHash: refreshTokenHash,
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
    expires_in: 3600,
    scope: params.scopes.join(' '),
  };
}

// ─── Hono App ───────────────────────────────────────────────────────────────

export const oauthApp = new Hono();

// ─── GET /authorize ─────────────────────────────────────────────────────────

oauthApp.get('/authorize', async (c) => {
  const clientId = c.req.query('client_id');
  const redirectUri = c.req.query('redirect_uri');
  const responseType = c.req.query('response_type');
  const scope = c.req.query('scope') ?? '';
  const state = c.req.query('state') ?? '';
  const codeChallenge = c.req.query('code_challenge');
  const codeChallengeMethod = c.req.query('code_challenge_method') ?? 'S256';

  if (!clientId || !redirectUri || responseType !== 'code' || !codeChallenge) {
    return c.json({ error: 'invalid_request', error_description: 'Missing required parameters: client_id, redirect_uri, response_type=code, code_challenge' }, 400);
  }

  if (codeChallengeMethod !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'Only code_challenge_method=S256 is supported' }, 400);
  }

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.active, true)))
    .limit(1);

  if (!client) {
    return c.json({ error: 'invalid_client', error_description: 'Client not found or inactive' }, 400);
  }

  const allowedUris = client.redirectUris ?? [];
  if (!parseRedirectUri(redirectUri) || !allowedUris.includes(redirectUri)) {
    return c.json({ error: 'invalid_request', error_description: 'redirect_uri not in allowed list' }, 400);
  }
  const scopes = validateRequestedScopes(parseScopeList(scope), client.scopes);
  if (!scopes) {
    return c.json({ error: 'invalid_scope' }, 400);
  }

  const requestId = createAuthorizationRequest({
    clientId,
    clientName: client.name,
    redirectUri,
    scopes,
    state,
    codeChallenge,
    codeChallengeMethod,
  });

  const frontendUrl = config.FRONTEND_URL || 'https://kortix.com';
  const consentUrl = new URL(`${frontendUrl}/oauth/authorize`);
  consentUrl.searchParams.set('request_id', requestId);

  return c.redirect(consentUrl.toString());
});

// ─── GET /authorize/consent/:requestId ──────────────────────────────────────

oauthApp.get('/authorize/consent/:requestId', supabaseAuth, async (c) => {
  const requestId = c.req.param('requestId');
  if (!requestId) {
    return c.json({ error: 'invalid_request', error_description: 'Missing request id' }, 400);
  }
  const request = getAuthorizationRequest(requestId);
  if (!request) {
    return c.json({ error: 'invalid_request', error_description: 'Authorization request expired or not found' }, 400);
  }

  return c.json({
    client_id: request.clientId,
    client_name: request.clientName,
    scope: request.scopes.join(' '),
    scopes: request.scopes,
  });
});

// ─── POST /authorize/consent ────────────────────────────────────────────────

oauthApp.post('/authorize/consent', supabaseAuth, async (c) => {
  const body = await c.req.json();
  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  const approved = body.approved === true;

  if (!requestId) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const request = consumeAuthorizationRequest(requestId);
  if (!request) {
    return c.json({ error: 'invalid_request', error_description: 'Authorization request expired or already used' }, 400);
  }

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, request.clientId), eq(oauthClients.active, true)))
    .limit(1);

  if (!client) {
    return c.json({ error: 'invalid_client' }, 400);
  }

  const allowedUris = client.redirectUris ?? [];
  const redirect = parseRedirectUri(request.redirectUri);
  if (!redirect || !allowedUris.includes(request.redirectUri)) {
    return c.json({ error: 'invalid_request', error_description: 'redirect_uri mismatch' }, 400);
  }

  const scopes = validateRequestedScopes(request.scopes, client.scopes);
  if (!scopes) {
    return c.json({ error: 'invalid_scope' }, 400);
  }

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
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await db.insert(oauthAuthorizationCodes).values({
    code,
    clientId: request.clientId,
    userId,
    accountId,
    redirectUri: request.redirectUri,
    scopes,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    expiresAt,
  });

  redirect.searchParams.set('code', code);
  if (request.state) redirect.searchParams.set('state', request.state);

  return c.json({ redirect_uri: redirect.toString() });
});

// ─── POST /token ────────────────────────────────────────────────────────────

oauthApp.post('/token', async (c) => {
  const body = await c.req.parseBody();
  const grantType = body['grant_type'] as string;
  const clientId = body['client_id'] as string;
  const clientSecret = body['client_secret'] as string;

  if (!clientId || !clientSecret) {
    return c.json({ error: 'invalid_request', error_description: 'Missing client_id or client_secret' }, 400);
  }

  if (!checkTokenRateLimit(clientId)) {
    return c.json({ error: 'rate_limit_exceeded', error_description: 'Too many token requests' }, 429);
  }

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.active, true)))
    .limit(1);

  if (!client) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  if (!verifySecretKey(clientSecret, client.clientSecretHash)) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(c, body, client);
  }

  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(c, body, client);
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});

async function handleAuthorizationCodeGrant(c: Context, body: Record<string, any>, client: any) {
  const code = body['code'] as string;
  const redirectUri = body['redirect_uri'] as string;
  const codeVerifier = body['code_verifier'] as string;

  if (!code || !redirectUri || !codeVerifier) {
    return c.json({ error: 'invalid_request', error_description: 'Missing code, redirect_uri, or code_verifier' }, 400);
  }

  const [authCode] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(
      and(
        eq(oauthAuthorizationCodes.code, code),
        eq(oauthAuthorizationCodes.clientId, client.clientId),
      ),
    )
    .limit(1);

  if (!authCode) {
    return c.json({ error: 'invalid_grant', error_description: 'Authorization code not found' }, 400);
  }

  if (authCode.usedAt) {
    return c.json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, 400);
  }

  if (authCode.expiresAt < new Date()) {
    return c.json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400);
  }

  if (authCode.redirectUri !== redirectUri) {
    return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
  }

  const computedChallenge = computeCodeChallenge(codeVerifier);
  const storedChallenge = authCode.codeChallenge;

  const computedBuf = Buffer.from(computedChallenge);
  const storedBuf = Buffer.from(storedChallenge);
  if (computedBuf.length !== storedBuf.length || !timingSafeEqual(computedBuf, storedBuf)) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
  }

  const [consumedCode] = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthAuthorizationCodes.id, authCode.id), isNull(oauthAuthorizationCodes.usedAt)))
    .returning();

  if (!consumedCode) {
    return c.json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, 400);
  }

  const tokenResponse = await issueTokenPair({
    clientId: client.clientId,
    userId: authCode.userId,
    accountId: authCode.accountId,
    scopes: (authCode.scopes as string[]) ?? [],
  });

  return c.json(tokenResponse);
}

async function handleRefreshTokenGrant(c: Context, body: Record<string, any>, client: any) {
  const refreshTokenRaw = body['refresh_token'] as string;

  if (!refreshTokenRaw) {
    return c.json({ error: 'invalid_request', error_description: 'Missing refresh_token' }, 400);
  }

  const refreshTokenHash = hashToken(refreshTokenRaw);

  const [refreshRow] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.tokenHash, refreshTokenHash),
        eq(oauthRefreshTokens.clientId, client.clientId),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    )
    .limit(1);

  if (!refreshRow) {
    return c.json({ error: 'invalid_grant', error_description: 'Refresh token not found or revoked' }, 400);
  }

  if (refreshRow.expiresAt < new Date()) {
    return c.json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400);
  }

  const now = new Date();
  const [consumedRefresh] = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshTokens.id, refreshRow.id), isNull(oauthRefreshTokens.revokedAt)))
    .returning();

  if (!consumedRefresh) {
    return c.json({ error: 'invalid_grant', error_description: 'Refresh token already used' }, 400);
  }

  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(eq(oauthAccessTokens.id, refreshRow.accessTokenId));

  const [oldAccess] = await db
    .select({ scopes: oauthAccessTokens.scopes })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.id, refreshRow.accessTokenId))
    .limit(1);

  const tokenResponse = await issueTokenPair({
    clientId: client.clientId,
    userId: refreshRow.userId,
    accountId: refreshRow.accountId,
    scopes: (oldAccess?.scopes as string[]) ?? [],
  });

  return c.json(tokenResponse);
}

// ─── GET /userinfo ──────────────────────────────────────────────────────────

oauthApp.get('/userinfo', oauthTokenAuth, async (c) => {
  const scopeError = requireOAuthScope(c, 'profile');
  if (scopeError) return scopeError;

  const userId = (c as any).get('oauthUserId') as string;
  const accountId = (c as any).get('oauthAccountId') as string;

  const { getSupabase } = await import('../shared/supabase');
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.admin.getUserById(userId);

  return c.json({
    user_id: userId,
    account_id: accountId,
    email: user?.email ?? '',
  });
});

// ─── GET /claimable-machines ────────────────────────────────────────────────

oauthApp.get('/claimable-machines', oauthTokenAuth, async (c) => {
  const scopeError = requireOAuthScope(c, 'machines:read');
  if (scopeError) return scopeError;

  const accountId = (c as any).get('oauthAccountId') as string;

  const rows = await db
    .select({
      sandbox_id: sandboxes.sandboxId,
      external_id: sandboxes.externalId,
      name: sandboxes.name,
      status: sandboxes.status,
      created_at: sandboxes.createdAt,
    })
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.accountId, accountId),
        eq(sandboxes.provider, 'justavps'),
        inArray(sandboxes.status, ['active', 'provisioning']),
      ),
    );

  return c.json({
    machines: rows.map((r) => ({
      sandbox_id: r.sandbox_id,
      external_id: r.external_id,
      name: r.name,
      status: r.status,
      created_at: r.created_at?.toISOString(),
    })),
  });
});
