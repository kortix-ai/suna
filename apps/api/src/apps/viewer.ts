/**
 * The App viewer — who is looking at a Kortix App, told to the App itself.
 *
 * The Apps gate already authenticates every visitor of a non-public App
 * (`authorizeAppRequest`: Kortix login → 8h HMAC cookie, or a Kortix
 * credential). Until now it kept that entirely to itself: the container saw
 * "someone allowed" and nothing more, so an App that wanted per-user data had
 * to build a second login. This module closes that gap WITHOUT handing an App
 * the viewer's own Kortix session:
 *
 *   1. **A signed viewer header on every proxied request**
 *      (`x-kortix-app-viewer`). Identity only — user id, email, group ids —
 *      signed with a per-App secret the App also holds (`KORTIX_APP_VIEWER_SECRET`,
 *      injected at deploy). Costs no database round-trip on the hot path.
 *   2. **An App-scoped access token on demand** (`GET /_kortix/viewer`).
 *      A real `kortix_oat_` bound to (this viewer, this App), minted through
 *      an implicit OAuth client owned by the App. It is NOT the user's Supabase
 *      session: it expires in an hour, it carries only the scopes the App was
 *      granted, and deleting the App revokes every token it ever minted.
 *
 * The user signs in to Kortix once. Every App they open is authenticated
 * instantly — no second login, no consent screen, no redirect — and the blast
 * radius of App code is one App-scoped token instead of a full session.
 *
 * `apps.viewer_token_scope` decides how much:
 *   `off`      — share nothing (pre-2026-08-27 behaviour).
 *   `identity` — header + a `profile email` token (default).
 *   `api`      — the above with `kortix`: the App acts AS the viewer on the
 *                Kortix API. The viewer's own IAM role is still the ceiling.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { accountGroupMembers, oauthAccessTokens, oauthClients } from '@kortix/db';
import { db } from '../shared/db';
import { hashSecretKey, randomAlphanumeric } from '../shared/crypto';
import { hashOauthToken } from '../oauth/token-hash';
/*
 * The narrow email lookup (drizzle + db, its own cache, never throws) rather
 * than `projects/lib/access`'s re-export of it: that module drags the whole
 * project/session/IAM read graph in behind it, which the gate does not need and
 * which every hand-written module mock in the suite would then have to grow a
 * matching export for.
 */
import { lookupEmailsByUserIds } from '../accounts/core/owner-emails';
import { appAccessSecret } from './access';

/** The signed identity the gate adds to every proxied request. */
export const APP_VIEWER_HEADER = 'x-kortix-app-viewer';
/**
 * The viewer's App-scoped Kortix token, added alongside the identity when the
 * App carries `viewer_token_scope: 'api'`. Only then: an `identity` token opens
 * nothing on the API, so shipping it on every request would be noise.
 */
export const APP_VIEWER_TOKEN_HEADER = 'x-kortix-app-viewer-token';
/** Where the App reads its verification secret. Injected at deploy. */
export const APP_VIEWER_SECRET_ENV = 'KORTIX_APP_VIEWER_SECRET';

export type AppViewerTokenScope = 'off' | 'identity' | 'api';

export function normalizeViewerTokenScope(value: unknown): AppViewerTokenScope {
  return value === 'off' || value === 'api' ? value : 'identity';
}

/** Scopes the minted token carries. `identity` never reaches the general API. */
export function appViewerScopes(scope: AppViewerTokenScope): string[] {
  if (scope === 'off') return [];
  return scope === 'api' ? ['profile', 'email', 'kortix'] : ['profile', 'email'];
}

/**
 * Per-App verification secret, derived from the platform secret. The App gets
 * THIS, never `appAccessSecret()`: a leaked App secret forges a viewer for that
 * one App and nothing else, and rotating the platform secret rotates them all.
 */
export function appViewerSecret(appId: string): string {
  return createHmac('sha256', appAccessSecret())
    .update('kortix-app-viewer-secret:v1\0')
    .update(appId)
    .digest('hex');
}

export interface AppViewerContext {
  v: 1;
  appId: string;
  userId: string;
  email: string | null;
  groupIds: string[];
  accountId: string;
  /** The App's access mode when this request was authorized. */
  accessMode: string;
  iat: number;
  exp: number;
}

const VIEWER_CONTEXT_TTL_SECONDS = 300;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function signContext(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update('kortix-app-viewer:v1\0').update(payloadB64).digest('base64url');
}

export function encodeAppViewerContext(
  input: Omit<AppViewerContext, 'v' | 'iat' | 'exp'> & { ttlSeconds?: number },
  secret: string,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: AppViewerContext = {
    v: 1,
    appId: input.appId,
    userId: input.userId,
    email: input.email,
    groupIds: input.groupIds,
    accountId: input.accountId,
    accessMode: input.accessMode,
    iat,
    exp: iat + (input.ttlSeconds ?? VIEWER_CONTEXT_TTL_SECONDS),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${signContext(payloadB64, secret)}`;
}

export type AppViewerVerifyResult =
  | { ok: true; viewer: AppViewerContext }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_json' };

export function verifyAppViewerContext(
  token: string | null | undefined,
  secret: string,
): AppViewerVerifyResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const [payloadB64, sig, extra] = token.split('.');
  if (!payloadB64 || !sig || extra) return { ok: false, reason: 'malformed' };
  const expected = signContext(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  let payload: AppViewerContext;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AppViewerContext;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, viewer: payload };
}

// ─── Identity cache ─────────────────────────────────────────────────────────
// Email + group membership for the header, on a 60s TTL so the proxy's hot
// path costs no query. Both change rarely and a stale minute only affects what
// the App DISPLAYS or which group grant it applies — never whether the gate let
// the viewer in, which is re-checked from the cookie on every request.

interface ViewerIdentity {
  email: string | null;
  groupIds: string[];
}

const IDENTITY_TTL_MS = 60_000;
const IDENTITY_MAX = 5_000;
const identityCache = new Map<string, { value: ViewerIdentity; expiresAt: number }>();

export function resetAppViewerCaches(): void {
  identityCache.clear();
  tokenCache.clear();
}

export async function resolveAppViewerIdentity(userId: string): Promise<ViewerIdentity> {
  const hit = identityCache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const [emails, groups] = await Promise.all([
    lookupEmailsByUserIds([userId]).catch(() => new Map<string, string | null>()),
    db
      .select({ groupId: accountGroupMembers.groupId })
      .from(accountGroupMembers)
      .where(eq(accountGroupMembers.userId, userId))
      .catch(() => [] as { groupId: string }[]),
  ]);
  const value: ViewerIdentity = {
    email: emails.get(userId) ?? null,
    groupIds: groups.map((g) => g.groupId),
  };
  if (identityCache.size >= IDENTITY_MAX) {
    for (const key of identityCache.keys()) {
      identityCache.delete(key);
      if (identityCache.size < IDENTITY_MAX * 0.9) break;
    }
  }
  identityCache.set(userId, { value, expiresAt: Date.now() + IDENTITY_TTL_MS });
  return value;
}

// ─── The implicit OAuth client + the viewer's token ─────────────────────────

export interface AppViewerTokenApp {
  appId: string;
  accountId: string;
  name: string;
  viewerTokenScope: string;
}

/**
 * One `oauth_clients` row per App, created on first use. It never runs the
 * redirect flow (no redirect URI is ever accepted for it) — it exists so the
 * tokens the gate mints hang off a revocable, App-owned principal. Deleting
 * the App cascades the client, its tokens, and its consents.
 */
async function ensureAppOAuthClient(app: AppViewerTokenApp): Promise<string> {
  const [existing] = await db
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.appId, app.appId))
    .limit(1);
  if (existing) return existing.clientId;
  const [created] = await db
    .insert(oauthClients)
    .values({
      appId: app.appId,
      accountId: app.accountId,
      name: `Kortix App — ${app.name}`,
      description: 'Implicit client for a Kortix-hosted App. Tokens are minted by the Apps gate for an already-authenticated viewer; it has no redirect URI and cannot run the authorization-code flow.',
      clientType: 'public',
      redirectUris: [],
      scopes: ['profile', 'email', 'kortix'],
      // Never presented anywhere: a public client authenticates with PKCE, and
      // this client never reaches /oauth/token at all. Stored so the NOT NULL
      // column holds a value nothing can match.
      clientSecretHash: hashSecretKey(`kortix_app_client_${randomAlphanumeric(48)}`),
      active: true,
    })
    .onConflictDoNothing()
    .returning({ clientId: oauthClients.clientId });
  if (created) return created.clientId;
  const [raced] = await db
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.appId, app.appId))
    .limit(1);
  if (!raced) throw new Error(`Could not resolve the implicit OAuth client for App ${app.appId}`);
  return raced.clientId;
}

export const APP_VIEWER_TOKEN_TTL_S = 3600;
/** Re-mint this long before expiry so a token handed out is always usable. */
const TOKEN_REUSE_FLOOR_MS = 5 * 60_000;
const TOKEN_CACHE_MAX = 10_000;

interface CachedToken {
  token: string;
  expiresAt: number;
  scopes: string[];
}

const tokenCache = new Map<string, CachedToken>();

export interface MintedAppViewerToken {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
}

/**
 * The viewer's App-scoped token.
 *
 * ONLY call this after `authorizeAppRequest` has allowed the request: it mints
 * a credential for `userId` with no further checks of its own.
 *
 * The plaintext is cached in-process (the row stores only a hash, so it cannot
 * be read back). A second API replica mints its own; both stay valid until they
 * expire, which is what makes this safe to run on every replica.
 */
export async function mintAppViewerToken(
  app: AppViewerTokenApp,
  userId: string,
): Promise<MintedAppViewerToken | null> {
  const scope = normalizeViewerTokenScope(app.viewerTokenScope);
  if (scope === 'off') return null;
  const scopes = appViewerScopes(scope);
  const key = `${app.appId}:${userId}:${scope}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - TOKEN_REUSE_FLOOR_MS > Date.now()) {
    return { accessToken: hit.token, expiresAt: new Date(hit.expiresAt), scopes: hit.scopes };
  }

  const clientId = await ensureAppOAuthClient(app);
  const accessToken = `kortix_oat_${randomAlphanumeric(48)}`;
  const expiresAt = new Date(Date.now() + APP_VIEWER_TOKEN_TTL_S * 1000);
  await db.insert(oauthAccessTokens).values({
    tokenHash: hashOauthToken(accessToken),
    clientId,
    userId,
    accountId: app.accountId,
    scopes,
    expiresAt,
  });

  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(key, { token: accessToken, expiresAt: expiresAt.getTime(), scopes });
  return { accessToken, expiresAt, scopes };
}

/** Revoke every live token this App minted (App deleted, access policy tightened). */
export async function revokeAppViewerTokens(appId: string): Promise<number> {
  const [client] = await db
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.appId, appId))
    .limit(1);
  if (!client) return 0;
  const rows = await db
    .update(oauthAccessTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthAccessTokens.clientId, client.clientId), isNull(oauthAccessTokens.revokedAt)))
    .returning({ id: oauthAccessTokens.id });
  for (const key of [...tokenCache.keys()]) {
    if (key.startsWith(`${appId}:`)) tokenCache.delete(key);
  }
  return rows.length;
}
