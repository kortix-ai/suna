/**
 * Move a Pipedream connector to the Kortix MCP app with the same service (`connectors_v2`).
 *
 * Kortix retires Pipedream. Its OAuth grants belong to Pipedream's client, so
 * each owner signs in once more. A move keeps the connector's slug and
 * connection rows, so agent grants, triggers, session bindings and other
 * kortix.yaml references do not change.
 *
 *   1. `moveConnector` marks one connection (`metadata.move_to`). Pipedream
 *      still serves the connector.
 *   2. The person signs in on that connection with the ordinary OAuth routes.
 *      For a marked connection, the OAuth target is the catalogue app for the
 *      connector's Pipedream `app` (`moveTargetUrl`). It never comes from the
 *      request or from stored metadata.
 *   3. When the sign-in stores its token, `finishMarkedMove` rewrites the
 *      kortix.yaml entry to `provider: mcp` and syncs. The other connections
 *      keep their rows but lose their Pipedream binding, so their owners sign
 *      in again.
 */
import { connectionCredentials, connectorConnections, connectors, projects } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { ensureDefaultConnection } from './credentials';
import { type CrudResult, upsertConnectorInManifest } from './manifest-crud';
import { MCP_APPS, type McpApp, mcpAppAvailable, mcpAppForUrl, mcpAppIcon } from './mcp-apps';

/**
 * Pipedream app slug → Kortix catalogue app. Slugs read from Pipedream's live
 * `/v1/apps` on 2026-10-19. Not mapped: data-center editions (`jira_data_center`),
 * `slack_bot` (a bot token, not a person), `neon_postgres` (a database login).
 */
const PIPEDREAM_TO_MCP_APP: Readonly<Record<string, string>> = {
  airtable_oauth: 'airtable',
  asana: 'asana',
  attio: 'attio',
  box: 'box',
  canva: 'canva',
  clickup: 'clickup',
  close: 'close',
  cloudflare_api_key: 'cloudflare',
  confluence: 'atlassian',
  dropbox: 'dropbox',
  figma: 'figma',
  github: 'github',
  gmail: 'gmail',
  google_calendar: 'google_calendar',
  google_docs: 'google_docs',
  google_drive: 'google_drive',
  google_sheets: 'google_sheets',
  granola: 'granola',
  hubspot: 'hubspot',
  intercom: 'intercom',
  jira: 'atlassian',
  jotform: 'jotform',
  linear: 'linear',
  linear_app: 'linear',
  miro_custom_app: 'miro',
  monday: 'monday',
  neon_api_keys: 'neon',
  notion: 'notion',
  notion_api_key: 'notion',
  paypal: 'paypal',
  posthog: 'posthog',
  sentry: 'sentry',
  slack: 'slack',
  slack_v2: 'slack',
  stripe: 'stripe',
  supabase: 'supabase',
  supabase_management_api: 'supabase',
  vercel_token_auth: 'vercel',
  webflow: 'webflow',
  wix_api_key: 'wix',
};

/** The catalogue app a Pipedream app moves to, when this deployment can sign in to it. */
export function mcpAppForPipedreamApp(app: unknown): McpApp | null {
  const slug = typeof app === 'string' ? PIPEDREAM_TO_MCP_APP[app] : undefined;
  const target = slug ? MCP_APPS.find((candidate) => candidate.slug === slug) : undefined;
  return target && mcpAppAvailable(target) ? target : null;
}

/** The MCP server a marked connection of a Pipedream connector signs in to, else null. */
export function moveTargetUrl(
  providerType: string,
  config: Record<string, unknown> | null,
  connectionMetadata: Record<string, unknown> | null,
): string | null {
  if (providerType !== 'pipedream') return null;
  const app = mcpAppForPipedreamApp(config?.app);
  return app && connectionMetadata?.move_to === app.slug ? app.url : null;
}

export interface ConnectorMove {
  slug: string;
  name: string;
  /** The connector's Pipedream app. */
  app: string | null;
  /** The Kortix app it moves to. Null: Kortix has no connection for this app on this deployment yet. */
  to: { slug: string; name: string; icon: string | null } | null;
  /** The connection a move signs in on, once a move started. */
  connection_id: string | null;
  /** The move signed in, and only the switch to `mcp` is left. */
  signed_in: boolean;
  /** Accounts on the connector. Every one except the moved one signs in again after the move. */
  accounts: number;
}

/** Every Pipedream connector of the project, with the Kortix app it can move to. */
export async function listConnectorMoves(projectId: string): Promise<ConnectorMove[]> {
  const rows = await db
    .select({ connectorId: connectors.connectorId, slug: connectors.slug, name: connectors.name, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.providerType, 'pipedream')));
  if (rows.length === 0) return [];
  const connections = await db
    .select({
      connectorId: connectorConnections.connectorId,
      connectionId: connectorConnections.connectionId,
      metadata: connectorConnections.metadata,
      kind: connectionCredentials.kind,
    })
    .from(connectorConnections)
    .leftJoin(connectionCredentials, eq(connectionCredentials.connectionId, connectorConnections.connectionId))
    .where(
      and(
        inArray(connectorConnections.connectorId, rows.map((row) => row.connectorId)),
        sql`${connectorConnections.status} <> 'revoked'`,
      ),
    );
  return rows
    .map((row) => {
      const app = (row.config as { app?: unknown } | null)?.app;
      const to = mcpAppForPipedreamApp(app);
      const own = connections.filter((connection) => connection.connectorId === row.connectorId);
      const marked = to ? own.find((connection) => connection.metadata?.move_to === to.slug) : undefined;
      return {
        slug: row.slug,
        name: row.name,
        app: typeof app === 'string' ? app : null,
        to: to ? { slug: to.slug, name: to.name, icon: mcpAppIcon(to) } : null,
        connection_id: marked?.connectionId ?? null,
        signed_in: marked?.kind === 'oauth2_delegated',
        accounts: own.length,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export type MoveResult =
  | { ok: true; status: 'sign_in'; connection_id: string; to: { slug: string; name: string; url: string } }
  | { ok: true; status: 'moved' }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string };

/**
 * Start a move, or finish one that signed in and did not switch (a failed
 * kortix.yaml write). `connectionId` picks the account to sign in on; the
 * default is the project's account.
 */
export async function moveConnector(input: {
  projectId: string;
  slug: string;
  userId: string;
  connectionId?: string;
}): Promise<MoveResult> {
  const [connector] = await db
    .select({ connectorId: connectors.connectorId, providerType: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, input.projectId), eq(connectors.slug, input.slug)))
    .limit(1);
  if (!connector) return { ok: false, status: 404, error: 'Connector not found' };
  // Moved already (the sign-in switched it): a client that finishes with a second call reads `moved`.
  const url = (connector.config as { url?: unknown } | null)?.url;
  if (connector.providerType === 'mcp' && typeof url === 'string' && mcpAppForUrl(url)) return { ok: true, status: 'moved' };
  if (connector.providerType !== 'pipedream') {
    return { ok: false, status: 409, error: `Only a Pipedream connector moves. ${input.slug} uses ${connector.providerType}.` };
  }
  const app = (connector.config as { app?: unknown } | null)?.app;
  const to = mcpAppForPipedreamApp(app);
  if (!to) {
    return {
      ok: false,
      status: 409,
      error: `Kortix has no connection for ${String(app ?? input.slug)} on this deployment yet. The connector keeps working through Pipedream.`,
    };
  }

  const own = await db
    .select({ connectionId: connectorConnections.connectionId, metadata: connectorConnections.metadata, kind: connectionCredentials.kind })
    .from(connectorConnections)
    .leftJoin(connectionCredentials, eq(connectionCredentials.connectionId, connectorConnections.connectionId))
    .where(eq(connectorConnections.connectorId, connector.connectorId));
  const signedIn = own.find((connection) => connection.metadata?.move_to === to.slug && connection.kind === 'oauth2_delegated');
  if (signedIn) {
    const finished = await finishMarkedMove(signedIn.connectionId);
    if (finished && !finished.ok) return { ok: false, status: 502, error: finished.error };
    return { ok: true, status: 'moved' };
  }

  let connectionId = input.connectionId;
  if (connectionId && !own.some((connection) => connection.connectionId === connectionId)) {
    return { ok: false, status: 400, error: `Connection ${connectionId} is not an account of ${input.slug}` };
  }
  connectionId ??= await ensureDefaultConnection({
    projectId: input.projectId,
    connectorId: connector.connectorId,
    createdBy: input.userId,
  });
  // One marked account per connector: a second start moves the mark.
  await db.transaction(async (tx) => {
    await tx
      .update(connectorConnections)
      .set({ metadata: sql`${connectorConnections.metadata} - 'move_to'`, updatedAt: new Date() })
      .where(and(eq(connectorConnections.connectorId, connector.connectorId), sql`${connectorConnections.metadata}->>'move_to' is not null`));
    await tx
      .update(connectorConnections)
      .set({ metadata: sql`${connectorConnections.metadata} || ${JSON.stringify({ move_to: to.slug })}::jsonb`, updatedAt: new Date() })
      .where(eq(connectorConnections.connectionId, connectionId));
  });
  return { ok: true, status: 'sign_in', connection_id: connectionId, to: { slug: to.slug, name: to.name, url: to.url } };
}

/**
 * Switch a Pipedream connector to its Kortix app once its marked connection
 * holds a Kortix sign-in. Null when the connection is not a signed-in move.
 * Called after every OAuth sign-in on a Pipedream connector, and by a retried
 * `moveConnector`.
 */
export async function finishMarkedMove(connectionId: string): Promise<CrudResult | null> {
  const [row] = await db
    .select({
      projectId: connectors.projectId,
      accountId: connectors.accountId,
      connectorId: connectors.connectorId,
      slug: connectors.slug,
      name: connectors.name,
      providerType: connectors.providerType,
      config: connectors.config,
      connectionMetadata: connectorConnections.metadata,
      kind: connectionCredentials.kind,
      projectMetadata: projects.metadata,
    })
    .from(connectorConnections)
    .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
    .innerJoin(projects, eq(projects.projectId, connectors.projectId))
    .leftJoin(connectionCredentials, eq(connectionCredentials.connectionId, connectorConnections.connectionId))
    .where(eq(connectorConnections.connectionId, connectionId))
    .limit(1);
  if (!row || row.kind !== 'oauth2_delegated' || !resolveFeatureFlag(row.projectMetadata, 'connectors_v2')) return null;
  const url = moveTargetUrl(row.providerType, row.config, row.connectionMetadata);
  if (!url) return null;

  const result = await upsertConnectorInManifest(
    row.projectId,
    row.accountId,
    { slug: row.slug, name: row.name, provider: 'mcp', url, transport: 'http' },
    async () => {
      // The other accounts hold Pipedream account ids, which no MCP server accepts:
      // without them, those accounts read "not signed in" and their owners sign in again.
      await db.transaction(async (tx) => {
        await tx
          .delete(connectionCredentials)
          .where(and(eq(connectionCredentials.connectorId, row.connectorId), eq(connectionCredentials.kind, 'connection')));
        await tx
          .update(connectorConnections)
          .set({ metadata: sql`${connectorConnections.metadata} - 'move_to'`, updatedAt: new Date() })
          .where(eq(connectorConnections.connectionId, connectionId));
      });
    },
  );
  if (!result.ok) {
    logger.warn('[connectors] Pipedream move did not switch the connector', { connectionId, error: result.error });
  }
  return result;
}
