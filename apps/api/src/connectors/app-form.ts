/**
 * The public form behind a connect link (`/connect/app/kaf_…`).
 *
 * Unauthenticated on purpose, like a setup link: the sealed token is the
 * capability, and it can do one thing, connect the one account it names, while
 * that account's latest Connect is still the one that minted it. The window
 * that opened the form keeps polling finalize and finishes the connect.
 *
 * Two flows share it:
 * - `provider: shopify` (native): the store and, without a shared app, the
 *   client ID and secret of the merchant's own app; submit answers Shopify's
 *   authorize URL (`shopify-connect.ts`).
 * - A Composio toolkit on the customer's own app (`composio-own-app.ts`): the
 *   app's client credentials and the store; submit connects at once.
 */
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../shared/db';
import { connectedAsOf } from './connection-identity';
import {
  composioConnectionMetadata,
  composioStableUserId,
  loadComposioAdapter,
  readRequestingSessionId,
} from './db-deps-connect';
import { normalizeShopifyStore, openAppFormToken, ownApp, type AppFormPayload } from './composio-own-app';
import { shopifyAccountConnected, shopifyFormInfo, submitShopifyForm, type ShopifyFormInfo } from './shopify-connect';

export interface AppFormInfo extends Partial<Omit<ShopifyFormInfo, 'flow'>> {
  app: string;
  /** The app's display name ("Shopify"). */
  name: string;
  /** The connector's name in the project. */
  connector: string;
  /** `oauth`: the native Shopify sign-in. `client_credentials`: Composio's own-app form. */
  flow: 'oauth' | 'client_credentials';
  /** The link already connected the account. */
  connected: boolean;
  /** The store the account reaches, once connected. */
  connected_as: string | null;
  expires_at: string;
}

export interface AppFormSubmitInput {
  store?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
}

export type AppFormResult =
  | { connected: true; connected_as: string; success_redirect_uri?: string }
  | { connected: false; authorize_url: string };

function refuse(status: 400 | 404 | 409 | 410 | 501, message: string, code: string): never {
  throw new HTTPException(status, {
    message,
    res: Response.json({ error: true, message, status, code }, { status }),
  });
}

async function loadLinkedConnection(payload: AppFormPayload) {
  const [row] = await db
    .select({
      metadata: connectorConnections.metadata,
      connectorId: connectorConnections.connectorId,
      accountId: connectorConnections.accountId,
      connectorName: connectors.name,
      providerType: connectors.providerType,
    })
    .from(connectorConnections)
    .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
    .where(
      and(
        eq(connectorConnections.connectionId, payload.cid),
        eq(connectorConnections.projectId, payload.pid),
      ),
    )
    .limit(1);
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  const native = row?.providerType === 'shopify' && payload.app === 'shopify';
  const composio =
    row?.providerType === 'composio' && String(metadata.toolkit ?? '').toLowerCase() === payload.app;
  if (!row || (!native && !composio)) refuse(404, 'This connect link is not valid.', 'app_form_not_found');
  if (metadata.auth_request_id !== payload.n) {
    refuse(409, 'A newer Connect replaced this link. Start Connect again in Kortix.', 'app_form_superseded');
  }
  const connected = native
    ? (metadata.shopify as { connected_request?: unknown } | undefined)?.connected_request === payload.n &&
      (await shopifyAccountConnected({ connectorId: row.connectorId, connectionId: payload.cid }))
    : typeof metadata.connected_account_id === 'string';
  return { row, metadata, native, connected };
}

function openOrRefuse(token: string): AppFormPayload {
  const opened = openAppFormToken(token);
  if (!opened.ok) refuse(opened.status, opened.error, opened.status === 410 ? 'app_form_expired' : 'app_form_not_found');
  return opened.payload;
}

export async function appFormInfo(token: string): Promise<AppFormInfo> {
  const payload = openOrRefuse(token);
  const { row, metadata, native, connected } = await loadLinkedConnection(payload);
  const base = {
    app: payload.app,
    name: ownApp(payload.app)!.name,
    connector: row.connectorName,
    connected,
    connected_as: connected ? connectedAsOf(metadata) : null,
    expires_at: new Date(payload.exp).toISOString(),
  };
  if (native) {
    return {
      ...base,
      ...(await shopifyFormInfo({ connectorId: row.connectorId, connectionId: payload.cid, metadata })),
    };
  }
  return { ...base, flow: 'client_credentials' };
}

function credential(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 512 || /\s/.test(text)) refuse(400, `Enter the ${label}.`, 'app_form_invalid');
  return text;
}

export async function submitAppForm(token: string, input: AppFormSubmitInput): Promise<AppFormResult> {
  const payload = openOrRefuse(token);
  const { row, native, connected } = await loadLinkedConnection(payload);
  if (connected) refuse(409, 'This link already connected the account. Start Connect again in Kortix to change it.', 'app_form_used');
  if (native) {
    return submitShopifyForm({ token, payload, accountId: row.accountId, connectorId: row.connectorId, body: input });
  }
  return submitComposioOwnApp(payload, input);
}

async function submitComposioOwnApp(
  payload: AppFormPayload,
  input: AppFormSubmitInput,
): Promise<{ connected: true; connected_as: string; success_redirect_uri?: string }> {
  const store = normalizeShopifyStore(input.store);
  if (!store) {
    refuse(400, 'Enter the store\'s myshopify.com name, such as acme for acme.myshopify.com.', 'app_form_invalid');
  }
  const clientId = credential(input.client_id, 'Client ID');
  const clientSecret = credential(input.client_secret, 'Client secret');

  const composio = await loadComposioAdapter();
  if (!composio?.connectOwnApp) refuse(501, 'Composio is not configured on this deployment.', 'composio_unavailable');
  const result = await composio.connectOwnApp({
    connectionId: payload.cid,
    toolkit: payload.app,
    store,
    clientId,
    clientSecret,
  });

  const connectedAs = `${store}.myshopify.com`;
  const written = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ metadata: connectorConnections.metadata })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, payload.cid))
      .limit(1)
      .for('update');
    const previous = (current?.metadata ?? {}) as Record<string, unknown>;
    // A newer Connect started while Composio worked: its link owns the row now.
    if (!current || previous.auth_request_id !== payload.n) return false;
    await tx
      .update(connectorConnections)
      .set({
        status: 'active',
        metadata: composioConnectionMetadata({
          toolkit: typeof previous.toolkit === 'string' ? previous.toolkit : payload.app,
          stableUserId: composioStableUserId(payload.cid),
          sessionId: result.sessionId,
          authRequestId: payload.n,
          connectedAccountId: result.connectedAccountId,
          isNoAuth: false,
          requestingSessionId: readRequestingSessionId(previous),
          previous,
          connectedAs,
        }),
        updatedAt: sql`now()`,
      })
      .where(eq(connectorConnections.connectionId, payload.cid));
    return true;
  });
  if (!written) {
    refuse(409, 'A newer Connect replaced this link. Start Connect again in Kortix.', 'app_form_superseded');
  }
  return {
    connected: true,
    connected_as: connectedAs,
    ...(payload.ok ? { success_redirect_uri: payload.ok } : {}),
  };
}
