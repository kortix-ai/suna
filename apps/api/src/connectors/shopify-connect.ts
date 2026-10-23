/**
 * Connecting a `provider: shopify` account: Kortix's form, Shopify's OAuth
 * authorization-code grant, and the store an account's token belongs to.
 *
 * 1. Connect (every path: the connector page, an agent's connect link, a setup
 *    link, the CLI) mints the form link `/connect/app/kaf_…` and records its
 *    nonce as the account's `auth_request_id`. A newer Connect makes an older
 *    link stale.
 * 2. The form asks for the store and, unless the operator configured a shared
 *    Shopify app, the Client ID and secret of the merchant's own Dev Dashboard
 *    app. Submit saves that app on the account and answers Shopify's authorize
 *    URL; the page sends the browser there.
 * 3. Shopify redirects to `GET /v1/connectors/shopify/callback`. It checks the
 *    state (one use, 10 minutes), Shopify's HMAC with the app secret, and that
 *    `shop` is the store the form named; then redeems the code, stores the
 *    token as the account's credential, checks what the token can read, and
 *    sends the browser back to the form, which shows the result.
 *
 * The store of an account is the host of its credential's token URL: the store
 * the grant was issued for. Connection metadata only mirrors it for display —
 * an account owner can rewrite metadata, so it never routes a call.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import { connectionOAuthSessions, connectorConnections, connectors } from '@kortix/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { config } from '../config';
import { logger } from '../lib/logger';
import { encryptProjectSecret } from '../projects/surface';
import { db } from '../shared/db';
import { appFormConnectUrl, newAppFormNonce, type AppFormPayload } from './composio-own-app';
import { CONNECTED_AS_KEY, relabelToIdentity } from './connection-identity';
import { connectionCredentialExists, delegatedCredentialApplication, upsertConnectionCredential } from './credentials';
import { connectorEgressFetch } from './egress';
import { createStoredDelegatedCredential } from './oauth2-delegated';
import { authorizationCanCompleteOAuth, loadOAuth2Application, saveOAuth2Application } from './oauth2-store';
import {
  SHOPIFY_DEFAULT_SCOPES,
  exchangeShopifyCode,
  executeShopifyCall,
  isShopDomain,
  shopifyAuthorizeUrl,
  shopifyShopDomain,
  shopifyStoreOrigin,
  shopifyTokenUrlShop,
  verifyShopifyHmac,
  type ShopifyAccess,
} from './shopify';
import type { FetchImpl } from './call';

export const SHOPIFY_CALLBACK_PATH = '/v1/connectors/shopify/callback';
// A Shopify session is an `authorization_code` row whose application is a
// Shopify app; each callback refuses the other kind (see `shopifyTokenUrlShop`).
const SESSION_FLOW = 'authorization_code';
const SESSION_TTL_MS = 10 * 60_000;
/** A permanent offline token never expires; the credential store wants a number. */
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

/** The redirect URI the Shopify app must list, from the public API origin. */
export function shopifyCallbackUrl(): string {
  const base = (config.KORTIX_URL ?? 'http://localhost:8008').replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}${SHOPIFY_CALLBACK_PATH}`;
}

function sharedApp(): { clientId: string; clientSecret: string } | null {
  return config.SHOPIFY_CLIENT_ID && config.SHOPIFY_CLIENT_SECRET
    ? { clientId: config.SHOPIFY_CLIENT_ID, clientSecret: config.SHOPIFY_CLIENT_SECRET }
    : null;
}

function storeOrigin(shop: string): string {
  return shopifyStoreOrigin(shop, config.KORTIX_SHOPIFY_STORE_ORIGIN);
}

function refuse(status: 400 | 404 | 409 | 410 | 501, message: string, code: string): never {
  throw new HTTPException(status, {
    message,
    res: Response.json({ error: true, message, status, code }, { status }),
  });
}

/** The store of an application saved for Shopify: the host of its token URL. */
function applicationShop(application: OAuth2ApplicationInput | null | undefined): string | null {
  return shopifyTokenUrlShop(application?.token_url);
}

async function connectorShopifyConfig(connectorId: string): Promise<{ shop: string | null; scopes: string[] }> {
  const [row] = await db
    .select({ config: connectors.config })
    .from(connectors)
    .where(eq(connectors.connectorId, connectorId))
    .limit(1);
  const cfg = (row?.config ?? {}) as { shop?: unknown; scopes?: unknown };
  const shop = isShopDomain(cfg.shop) ? cfg.shop : null;
  const scopes =
    Array.isArray(cfg.scopes) && cfg.scopes.every((v) => typeof v === 'string') && cfg.scopes.length
      ? (cfg.scopes as string[])
      : [...SHOPIFY_DEFAULT_SCOPES];
  return { shop, scopes };
}

/**
 * The store an account's calls go to: the store its OAuth grant was issued
 * for, else (a token pasted with `kortix connectors credential`) the
 * connector's `shop`. Null when neither is known.
 */
export async function shopifyStoreForConnection(input: {
  connectorId: string;
  connectionId: string | null;
}): Promise<string | null> {
  if (input.connectionId) {
    const shop = applicationShop(
      await delegatedCredentialApplication({ connectorId: input.connectorId, connectionId: input.connectionId }),
    );
    if (shop) return shop;
  }
  return (await connectorShopifyConfig(input.connectorId)).shop;
}

export async function shopifyStoreOriginForConnection(input: {
  connectorId: string;
  connectionId: string | null;
}): Promise<string | null> {
  const shop = await shopifyStoreForConnection(input);
  return shop ? storeOrigin(shop) : null;
}

// ─── 1. Connect ─────────────────────────────────────────────────────────────

/** Start Connect on one account: the form link, with a fresh nonce. */
export async function startShopifyConnect(input: {
  projectId: string;
  connectionId: string;
  userId: string;
  successRedirect?: string;
}): Promise<{ connectUrl: string; requestId: string }> {
  const nonce = newAppFormNonce();
  await db
    .update(connectorConnections)
    .set({
      metadata: sql`coalesce(${connectorConnections.metadata}, '{}'::jsonb) || ${JSON.stringify({ provider: 'shopify', auth_request_id: nonce })}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(connectorConnections.connectionId, input.connectionId),
        eq(connectorConnections.projectId, input.projectId),
      ),
    );
  return {
    connectUrl: appFormConnectUrl({
      projectId: input.projectId,
      connectionId: input.connectionId,
      app: 'shopify',
      nonce,
      successRedirect: input.successRedirect,
      userId: input.userId,
    }),
    requestId: nonce,
  };
}

/** Whether an account holds a Shopify token. Finalize reads this. */
export async function shopifyAccountConnected(input: {
  connectorId: string;
  connectionId: string;
}): Promise<boolean> {
  return connectionCredentialExists(input);
}

// ─── 2. The form ────────────────────────────────────────────────────────────

export interface ShopifyFormInfo {
  flow: 'oauth';
  /** The store the form starts with: the account's, else the connector's default. */
  shop: string | null;
  /** True when the operator's shared app connects, so no Client ID or secret is asked. */
  shared_app: boolean;
  scopes: string[];
  /** The redirect URL the merchant's app must list. */
  redirect_uri: string;
  /** What the account's token could read when it connected. */
  access: ShopifyAccess | null;
}

export async function shopifyFormInfo(input: {
  connectorId: string;
  connectionId: string;
  metadata: Record<string, unknown>;
}): Promise<ShopifyFormInfo> {
  const settings = await connectorShopifyConfig(input.connectorId);
  const accountShop = isShopDomain(input.metadata.shop) ? input.metadata.shop : null;
  const access = (input.metadata.shopify as { access?: ShopifyAccess } | undefined)?.access ?? null;
  return {
    flow: 'oauth',
    shop: accountShop ?? settings.shop,
    shared_app: sharedApp() !== null,
    scopes: settings.scopes,
    redirect_uri: shopifyCallbackUrl(),
    access,
  };
}

function credential(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 512 || /\s/.test(text)) refuse(400, `Enter the ${label}.`, 'app_form_invalid');
  return text;
}

/** Save the account's app and start Shopify's grant: the authorize URL. */
export async function submitShopifyForm(input: {
  token: string;
  payload: AppFormPayload;
  accountId: string;
  connectorId: string;
  body: { store?: unknown; client_id?: unknown; client_secret?: unknown };
}): Promise<{ connected: false; authorize_url: string }> {
  const { payload } = input;
  if (!payload.u) refuse(409, 'This link cannot start a Shopify sign-in. Start Connect again in Kortix.', 'app_form_superseded');
  const shop = shopifyShopDomain(input.body.store);
  if (!shop) {
    refuse(400, "Enter the store's myshopify.com name, such as acme for acme.myshopify.com.", 'app_form_invalid');
  }
  const shared = sharedApp();
  const own = input.body.client_id !== undefined || input.body.client_secret !== undefined;
  const app =
    own || !shared
      ? { clientId: credential(input.body.client_id, 'Client ID'), clientSecret: credential(input.body.client_secret, 'Client secret') }
      : shared;
  const settings = await connectorShopifyConfig(input.connectorId);
  const application: OAuth2ApplicationInput = {
    client_id: app.clientId,
    client_secret: app.clientSecret,
    token_endpoint_auth_method: 'client_secret_post',
    // Canonical store URLs: the token URL's host names the account's store.
    authorization_url: `https://${shop}/admin/oauth/authorize`,
    token_url: `https://${shop}/admin/oauth/access_token`,
    // Shopify reads `scope` comma-separated, set here, not via the space-joined `scopes`.
    authorization_params: { scope: settings.scopes.join(',') },
  };
  await saveOAuth2Application(
    { accountId: input.accountId, projectId: payload.pid, connectorId: input.connectorId, connectionId: payload.cid },
    application,
    payload.u,
  );
  const loaded = await loadOAuth2Application(payload.cid);
  if (!loaded) throw new Error('Shopify app was not saved');

  const state = randomBytes(32).toString('base64url');
  const formPage = appFormPageUrl(input.token);
  const successRedirect = payload.ok ?? formPage;
  await db.insert(connectionOAuthSessions).values({
    applicationId: loaded.applicationId,
    accountId: loaded.accountId,
    projectId: loaded.projectId,
    connectionId: loaded.connectionId,
    initiatedBy: payload.u,
    flow: SESSION_FLOW,
    stateHash: createHash('sha256').update(state).digest('hex'),
    // Shopify takes no PKCE; the column is required for every authorization-code row.
    pkceVerifierEnc: encryptProjectSecret(loaded.projectId, randomBytes(32).toString('base64url')),
    successRedirectUri: successRedirect,
    errorRedirectUri: formPage,
    scopes: settings.scopes,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return {
    connected: false,
    authorize_url: shopifyAuthorizeUrl({
      origin: storeOrigin(shop),
      clientId: app.clientId,
      scopes: settings.scopes,
      redirectUri: shopifyCallbackUrl(),
      state,
    }),
  };
}

function appFormPageUrl(token: string): string {
  return `${config.FRONTEND_URL.replace(/\/+$/, '')}/connect/app/${token}`;
}

// ─── 3. The callback ────────────────────────────────────────────────────────

type CallbackOutcome = { status: 302; location: string } | { status: 400; body: string };

function redirectWith(uri: string | null, params: Record<string, string>): CallbackOutcome {
  const target = uri;
  if (!target) {
    return { status: 400, body: `Shopify connection failed (${params.error ?? 'unknown'}). Start Connect again in Kortix.` };
  }
  const url = new URL(target);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return { status: 302, location: url.href };
}

/** What the token can read: one `check_access` query. Best effort: never fails the connect. */
async function probeAccess(origin: string, token: string, fetchImpl: FetchImpl): Promise<ShopifyAccess | null> {
  try {
    const result = await executeShopifyCall({ origin, action: 'check_access', args: {}, token, fetchImpl });
    return result.ok ? (result.data as ShopifyAccess) : null;
  } catch {
    return null;
  }
}

export async function completeShopifyCallback(
  requestUrl: string,
  fetchImpl: FetchImpl = connectorEgressFetch,
): Promise<CallbackOutcome> {
  const params = new URL(requestUrl).searchParams;
  const state = params.get('state');
  if (!state || state.length > 1024) return { status: 400, body: 'Shopify connection failed (invalid_state).' };
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(connectionOAuthSessions)
      .where(
        and(
          eq(connectionOAuthSessions.stateHash, createHash('sha256').update(state).digest('hex')),
          eq(connectionOAuthSessions.flow, SESSION_FLOW),
          eq(connectionOAuthSessions.status, 'pending'),
          isNull(connectionOAuthSessions.consumedAt),
          gt(connectionOAuthSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) return null;
    await tx
      .update(connectionOAuthSessions)
      .set({ status: 'consumed', consumedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectionOAuthSessions.sessionId, row.sessionId));
    return row;
  });
  if (!claimed) {
    return { status: 400, body: 'Shopify connection failed (invalid_state): this sign-in was already used or expired. Start Connect again in Kortix.' };
  }
  const fail = (code: string) => redirectWith(claimed.errorRedirectUri, { error: code });

  const loaded = await loadOAuth2Application(claimed.connectionId);
  const shop = applicationShop(loaded?.application);
  if (!loaded || !shop || !loaded.application.client_secret) return fail('app_missing');
  if (!verifyShopifyHmac(params, loaded.application.client_secret)) return fail('invalid_signature');
  if (params.get('shop')?.toLowerCase() !== shop) return fail('shop_mismatch');
  const code = params.get('code');
  if (!code) return fail('authorization_failed');
  if (!(await authorizationCanCompleteOAuth(claimed.connectionId, claimed.initiatedBy))) {
    return fail('authorization_strategy_changed');
  }

  const origin = storeOrigin(shop);
  let token;
  try {
    token = await exchangeShopifyCode(
      {
        origin,
        clientId: loaded.application.client_id,
        clientSecret: loaded.application.client_secret,
        code,
        // Shopify requires expiring offline tokens of new public apps: the shared app.
        expiring: sharedApp()?.clientId === loaded.application.client_id,
      },
      fetchImpl,
    );
  } catch (error) {
    logger.warn('[shopify] token exchange failed', { connectionId: claimed.connectionId, err: (error as Error).message });
    return fail('token_exchange_failed');
  }
  const now = Date.now();
  await upsertConnectionCredential({
    projectId: loaded.projectId,
    connectorId: loaded.connectorId,
    connectionId: loaded.connectionId,
    kind: 'oauth2_delegated',
    createdBy: claimed.initiatedBy,
    value: createStoredDelegatedCredential(loaded.application, {
      access_token: token.accessToken,
      ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}),
      token_type: 'Bearer',
      expires_at: token.expiresIn ? now + token.expiresIn * 1000 : NEVER_EXPIRES,
      scopes: token.scopes,
    }),
  });

  const access = await probeAccess(origin, token.accessToken, fetchImpl);
  const display = {
    provider: 'shopify',
    shop,
    scopes: token.scopes,
    [CONNECTED_AS_KEY]: shop,
  };
  const shopify = { access, checked_at: new Date(now).toISOString() };
  await db
    .update(connectorConnections)
    .set({
      status: 'active',
      // `connected_request` names the form link that completed, so the form
      // shows "connected" for that link only, not for a later reconnect link.
      metadata: sql`coalesce(${connectorConnections.metadata}, '{}'::jsonb) || ${JSON.stringify(display)}::jsonb
        || jsonb_build_object('shopify', ${JSON.stringify(shopify)}::jsonb
          || jsonb_build_object('connected_request', ${connectorConnections.metadata}->>'auth_request_id'))`,
      updatedAt: sql`now()`,
    })
    .where(eq(connectorConnections.connectionId, loaded.connectionId));
  await relabelToIdentity({ connectionId: loaded.connectionId, identity: shop }).catch(() => null);
  return redirectWith(claimed.successRedirectUri, { connected: '1' });
}
