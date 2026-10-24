/** Easy-connect plumbing for the DB-backed deps: Composio connection metadata, the requesting session, Pipedream/Composio connector loads, and connect-link eligibility. */
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { rowMetadata, CONNECTED_AS_KEY } from './connection-identity';
import { mcpAppForUrl } from './mcp-apps';
import { discoverProtectedResourceOAuth2, mcpSignInCheck } from './oauth2-resource-discovery';

export function composioConnectionMetadata(input: {
  toolkit: string;
  stableUserId: string;
  sessionId: string;
  authRequestId?: string;
  connectedAccountId?: string;
  isNoAuth: boolean;
  /** Kortix session whose agent asked for this connector. Deliberately NOT
   *  `session_id` — that key is Composio's Tool Router session (`trs_…`). */
  requestingSessionId?: string | null;
  /** The previous metadata. Its row-level keys (`rowMetadata`) are kept. */
  previous?: unknown;
  /** The authorized identity (`probeComposioIdentity`). Omitted when unknown. */
  connectedAs?: string | null;
}): Record<string, unknown> {
  return {
    ...rowMetadata(input.previous),
    provider: 'composio',
    toolkit: input.toolkit,
    stable_user_id: input.stableUserId,
    session_id: input.sessionId,
    auth_request_id: input.authRequestId ?? null,
    connected_account_id: input.connectedAccountId ?? null,
    is_no_auth: input.isNoAuth,
    requesting_session_id: input.requestingSessionId ?? null,
    ...(input.connectedAs ? { [CONNECTED_AS_KEY]: input.connectedAs } : {}),
  };
}

/**
 * The Kortix session whose agent asked for this connector, as stored on the
 * connection row. Provider-neutral on purpose: Composio writes it inside
 * `composioConnectionMetadata`, Pipedream through `mergeRequestingSession`,
 * and finalize reads both through this one accessor.
 */
export function readRequestingSessionId(metadata: unknown): string | null {
  const value = (metadata as Record<string, unknown> | null)?.requesting_session_id;
  return typeof value === 'string' && value ? value : null;
}

/** Stamp the requesting session onto a connection row without disturbing the
 *  rest of its metadata (Pipedream keeps provider state there). */
export async function mergeRequestingSession(
  connectionId: string,
  requestingSessionId: string | null | undefined,
): Promise<void> {
  if (!requestingSessionId) return;
  const [row] = await db
    .select({ metadata: connectorConnections.metadata })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId))
    .limit(1);
  await db
    .update(connectorConnections)
    .set({
      metadata: {
        ...((row?.metadata ?? {}) as Record<string, unknown>),
        requesting_session_id: requestingSessionId,
      },
      updatedAt: sql`now()`,
    })
    .where(eq(connectorConnections.connectionId, connectionId));
}

/** Load a pipedream connector's app slug + id (verifies provider). */
export async function loadPipedreamConnector(projectId: string, slug: string) {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'pipedream') return null;
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return null;
  return { connectorId: row.connectorId, app };
}

/** Load an MCP connector's id and server URL (verifies provider). */
export async function loadMcpConnector(projectId: string, slug: string) {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      accountId: connectors.accountId,
      providerType: connectors.providerType,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  const url = (row?.config as { url?: unknown } | null)?.url;
  if (!row || row.providerType !== 'mcp' || typeof url !== 'string' || !url) return null;
  return { connectorId: row.connectorId, accountId: row.accountId, url };
}

/** Load a Composio connector's toolkit slug + id (verifies provider). */
export async function loadComposioConnector(projectId: string, slug: string) {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      accountId: connectors.accountId,
      providerType: connectors.providerType,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'composio') return null;
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return null;
  return { connectorId: row.connectorId, accountId: row.accountId, app };
}

type ComposioAdapter = {
  composioConfigured(): boolean;
  composioCatalogPage?(input: {
    projectId: string;
    q?: string;
    category?: string;
    cursor?: string;
    limit?: number;
  }): Promise<unknown>;
  composioCatalogSections?(input: { perCategory?: number; maxCategories?: number }): Promise<unknown>;
  composioConnectUrl(input: {
    projectId: string;
    slug: string;
    app: string;
    connectionId: string;
    stableUserId: string;
    redirects?: { success?: string; error?: string };
  }): Promise<{ connectUrl?: string; sessionId: string; authRequestId?: string; connectedAccountId?: string; isNoAuth: boolean; connected: boolean }>;
  finalizeComposioConnection(input: {
    projectId: string;
    slug: string;
    app: string;
    connectionId: string;
    stableUserId: string;
    sessionId: string;
    authRequestId?: string;
    expectedConnectedAccountId?: string;
  }): Promise<{ connected: boolean; connectedAccountId?: string; sessionId: string; authRequestId?: string; isNoAuth: boolean }>;
  probeComposioIdentity?(input: {
    app: string;
    sessionId: string;
    connectedAccountId: string;
  }): Promise<string | null>;
  /** A connection on the customer's own app (`composio-own-app.ts`). */
  connectOwnApp?(input: {
    connectionId: string;
    toolkit: string;
    store: string;
    clientId: string;
    clientSecret: string;
  }): Promise<{ sessionId: string; connectedAccountId: string }>;
};

export async function loadComposioAdapter(): Promise<ComposioAdapter | null> {
  if (!config.COMPOSIO_API_KEY) return null;
  try {
    await import('@composio/core');
    const modulePath = './composio';
    return (await import(modulePath)) as ComposioAdapter;
  } catch (err) {
    console.warn('[composio] adapter unavailable', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function composioStableUserId(connectionId: string): string {
  return `kortix-connection:${connectionId}`;
}

export type ConnectLinkEligibility =
  | {
      ok: true;
      connectorId: string;
      app: string;
      /** Which provider mints the hosted page behind the link. `mcp`: Kortix's own OAuth sign-in. */
      providerType: 'pipedream' | 'composio' | 'mcp';
    }
  /** No connector with this slug on the project. The manifest really is missing it. */
  | { ok: false; reason: 'no_such_connector' }
  /** It exists, but no hosted-authorization provider backs it (channel, computer, custom). */
  | { ok: false; reason: 'unsupported_provider'; providerType: string }
  /** Provider-backed but its config names no app — a broken connector, not a missing one. */
  | { ok: false; reason: 'no_app' };

/**
 * Why a connect link can or cannot be minted for this slug.
 *
 * `loadPipedreamConnector` answers all three failures with `null`, so the mint
 * route told everyone to "add it to kortix.yaml first" — including the people
 * whose connector is already in kortix.yaml and simply is not Pipedream-backed.
 * That sends someone to edit a file that already has the entry they are being
 * asked to add, and the connector they actually need is reachable by a route
 * this one cannot offer.
 */
export async function connectLinkEligibility(
  projectId: string,
  slug: string,
): Promise<ConnectLinkEligibility> {
  const [row] = await db
    .select({
      connectorId: connectors.connectorId,
      providerType: connectors.providerType,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!row) return { ok: false, reason: 'no_such_connector' };
  // Composio counts. A setup link is "a hosted page that authorizes this
  // connector", and both providers offer one — the Pipedream-only check here is
  // what forced a Composio connector down the fallback path where the agent
  // pastes a raw provider URL into the transcript. The web renderer only turns
  // OUR `/connect/<token>` link into a button, so that fallback lost the button,
  // the modal, and the resume, and left three renderings of one action on screen.
  // An MCP server signs in through Kortix's own OAuth flow (oauth2-store
  // `startConnectionSignIn`): a link works when that sign-in is one click.
  if (row.providerType === 'mcp') {
    const url = (row.config as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !(await mcpOneClickSignIn(url))) {
      return { ok: false, reason: 'unsupported_provider', providerType: row.providerType };
    }
    return { ok: true, connectorId: row.connectorId, app: mcpAppForUrl(url)?.slug ?? slug, providerType: 'mcp' };
  }
  if (row.providerType !== 'pipedream' && row.providerType !== 'composio') {
    return {
      ok: false,
      reason: 'unsupported_provider',
      providerType: row.providerType,
    };
  }
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return { ok: false, reason: 'no_app' };
  return {
    ok: true,
    connectorId: row.connectorId,
    app,
    providerType: row.providerType,
  };
}

/** Whether the MCP server at `url` signs in in one click. Never throws. */
async function mcpOneClickSignIn(url: string): Promise<boolean> {
  try {
    return mcpSignInCheck(await discoverProtectedResourceOAuth2({ resourceUrl: url, provider: 'mcp' })).one_click;
  } catch {
    return false;
  }
}
