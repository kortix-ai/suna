/**
 * The public form behind an own-app connect link (`composio-own-app.ts`).
 *
 * Unauthenticated on purpose, like a setup link: the sealed token IS the
 * capability, and it can do one thing, connect the one connection it names,
 * while that connection's latest Connect is still the one that minted it.
 * The window that opened the form keeps polling finalize, which sees the
 * account this writes and finishes the connect as for any other toolkit.
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

export interface AppFormInfo {
  app: string;
  /** The app's display name ("Shopify"). */
  name: string;
  /** The connector's name in the project. */
  connector: string;
  /** The link was used: the connection holds the account it made. */
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
  if (!row || row.providerType !== 'composio' || String(metadata.toolkit ?? '').toLowerCase() !== payload.app) {
    refuse(404, 'This connect link is not valid.', 'app_form_not_found');
  }
  if (metadata.auth_request_id !== payload.n) {
    refuse(409, 'A newer Connect replaced this link. Start Connect again in Kortix.', 'app_form_superseded');
  }
  return { row, metadata, connected: typeof metadata.connected_account_id === 'string' };
}

function openOrRefuse(token: string): AppFormPayload {
  const opened = openAppFormToken(token);
  if (!opened.ok) refuse(opened.status, opened.error, opened.status === 410 ? 'app_form_expired' : 'app_form_not_found');
  return opened.payload;
}

export async function appFormInfo(token: string): Promise<AppFormInfo> {
  const payload = openOrRefuse(token);
  const { row, metadata, connected } = await loadLinkedConnection(payload);
  return {
    app: payload.app,
    name: ownApp(payload.app)!.name,
    connector: row.connectorName,
    connected,
    connected_as: connected ? connectedAsOf(metadata) : null,
    expires_at: new Date(payload.exp).toISOString(),
  };
}

function credential(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 512 || /\s/.test(text)) refuse(400, `Enter the ${label}.`, 'app_form_invalid');
  return text;
}

export async function submitAppForm(
  token: string,
  input: AppFormSubmitInput,
): Promise<{ connected: true; connected_as: string; success_redirect_uri?: string }> {
  const payload = openOrRefuse(token);
  const store = normalizeShopifyStore(input.store);
  if (!store) {
    refuse(400, 'Enter the store\'s myshopify.com name, such as acme for acme.myshopify.com.', 'app_form_invalid');
  }
  const clientId = credential(input.client_id, 'Client ID');
  const clientSecret = credential(input.client_secret, 'Client secret');
  const { connected } = await loadLinkedConnection(payload);
  if (connected) refuse(409, 'This link already connected the account. Start Connect again in Kortix to change it.', 'app_form_used');

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
    const [row] = await tx
      .select({ metadata: connectorConnections.metadata })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, payload.cid))
      .limit(1)
      .for('update');
    const previous = (row?.metadata ?? {}) as Record<string, unknown>;
    // A newer Connect started while Composio worked: its link owns the row now.
    if (!row || previous.auth_request_id !== payload.n) return false;
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
