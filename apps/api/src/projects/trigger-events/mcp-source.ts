/**
 * The `mcp` event source: Kortix checks the connected account's MCP server on
 * its own infra (mcp-poll.ts) and feeds the same pipeline as a webhook source.
 * `subscribe` only writes the poll stream: it runs inside the reconciler's
 * project lock, so it makes no vendor call. The first check reports problems
 * onto the trigger rows within seconds.
 */
import { connectorActions, connectorConnections, connectors } from '@kortix/db';
import { and, asc, eq } from 'drizzle-orm';
import { MCP_APPS, availableMcpApps, mcpAppForUrl, mcpAppIcon } from '../../connectors/mcp-apps';
import { db } from '../../shared/db';
import { resolveProjectAutomationActor } from '../session-lifecycle/actor';
import {
  CURATED_EVENTS,
  GENERIC_PREFIX,
  curatedEventsFor,
  genericEventFor,
  intervalSeconds,
  isListTool,
  streamConfig,
  type EventDefinition,
  type ToolAction,
} from './mcp-events';
import { MAX_STREAMS_PER_PROJECT, countStreams, deleteStream, getStream, streamIdFor, upsertStream } from './poll-store';
import { EventConnectionNotReadyError, EventSignatureError, type EventSourceProvider, type EventTypeInfo } from './types';

export const MCP_SOURCE_ID = 'mcp';

type ConnectorRow = { provider: string; config: unknown; slug: string };

/**
 * The app a connector's events belong to: `config.app` (Composio), else the
 * catalogue app of an MCP server URL, else (a custom MCP server) its own slug.
 * `mcpAvailable` false (a project without connectors_v2): `config.app` only, as before.
 */
export function connectorEventApp(row: ConnectorRow, mcpAvailable = true): string | null {
  const config = (row.config ?? {}) as Record<string, unknown>;
  if (typeof config.app === 'string' && config.app) return config.app;
  if (!mcpAvailable || row.provider !== 'mcp' || typeof config.url !== 'string') return null;
  return mcpAppForUrl(config.url)?.slug ?? row.slug;
}

/** People read this name in errors: the catalogue name, else the connector's slug. */
export function appLabel(app: string): string {
  return MCP_APPS.find((a) => a.slug === app)?.name ?? app;
}

async function connectorTools(connectorId: string): Promise<ToolAction[]> {
  const rows = await db
    .select({
      path: connectorActions.path,
      name: connectorActions.name,
      description: connectorActions.description,
      inputSchema: connectorActions.inputSchema,
      outputSchema: connectorActions.outputSchema,
      risk: connectorActions.risk,
      binding: connectorActions.binding,
    })
    .from(connectorActions)
    .where(eq(connectorActions.connectorId, connectorId))
    .orderBy(asc(connectorActions.path));
  return rows.map((r) => ({
    ...r,
    bindingKind: typeof (r.binding as Record<string, unknown>)?.kind === 'string' ? String((r.binding as Record<string, unknown>).kind) : null,
  }));
}

/** The generic `new_item.<tool>` types of one connector: one per synced list or search tool. */
export async function genericEventTypes(connectorId: string, app: string): Promise<EventDefinition[]> {
  return (await connectorTools(connectorId)).filter(isListTool).map((tool) => genericEventFor(tool, app));
}

/** A type of this connector: curated for its app, or generic for one of its tools. */
export async function definitionFor(type: string, connectorId: string, app: string): Promise<{ def: EventDefinition | null; tools: ToolAction[] }> {
  const tools = await connectorTools(connectorId);
  const curated = CURATED_EVENTS.find((d) => d.type === type && d.app === app);
  if (curated) return { def: curated, tools };
  if (!type.startsWith(GENERIC_PREFIX)) return { def: null, tools };
  const tool = tools.find((t) => t.path === type.slice(GENERIC_PREFIX.length));
  return { def: tool ? genericEventFor(tool, app) : null, tools };
}

/** The tool problem that stops a definition from running unattended, or null. */
export function toolProblem(def: EventDefinition, tools: readonly ToolAction[], label: string): string | null {
  const tool = tools.find((t) => t.path === def.tool);
  if (!tool) return `${label} does not offer the tool ${def.tool}. Reconnect ${label} so Kortix reads its tools again.`;
  if (tool.risk !== 'read') {
    return `${def.tool} can change data in ${label}, so a trigger cannot run it unattended. Pick an event whose tool only reads.`;
  }
  return null;
}

const asInfo = (def: EventDefinition): EventTypeInfo => ({
  type: def.type,
  name: def.name,
  description: def.description,
  app: def.app,
  delivery: def.delivery,
  configSchema: def.configSchema,
  payloadSchema: def.payloadSchema,
});

export const mcpEventSource: EventSourceProvider = {
  id: MCP_SOURCE_ID,
  // Polling needs nothing from the deployment. KORTIX_EVENT_POLLS_ENABLED pauses the worker only.
  configured: () => true,
  ingressConfigured: () => false,

  async listEventTypes(app) {
    return curatedEventsFor(app).map(asInfo);
  },

  async listConnectorEventTypes({ connectorId, app }) {
    return [...curatedEventsFor(app), ...(await genericEventTypes(connectorId, app))].map(asInfo);
  },

  async listApps() {
    // A server with no sign-in has no account to watch.
    return availableMcpApps()
      .filter((app) => app.auth.kind !== 'none')
      .map((app) => ({ app: app.slug, name: app.name, logo: mcpAppIcon(app), eventCount: curatedEventsFor(app.slug).length }));
  },

  async subscribe({ connection, type, config }) {
    const [row] = await db
      .select({
        projectId: connectorConnections.projectId,
        accountId: connectorConnections.accountId,
        connectorId: connectors.connectorId,
      })
      .from(connectorConnections)
      .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
      .where(eq(connectorConnections.connectionId, connection.connectionId))
      .limit(1);
    const label = appLabel(connection.app);
    if (!row) throw new EventConnectionNotReadyError(`Connect a shared ${label} account to activate this trigger.`);
    const { def, tools } = await definitionFor(type, row.connectorId, connection.app);
    // Tools sync right after sign-in: none yet means the account is still connecting.
    if (tools.length === 0) throw new EventConnectionNotReadyError(`Finish connecting the shared ${label} account to activate this trigger.`);
    if (!def) throw new Error(`Unknown event ${type} for ${connection.connectorSlug}. Run kortix triggers events --connector ${connection.connectorSlug}.`);
    const problem = toolProblem(def, tools, label);
    if (problem) throw new Error(problem);
    const settings = streamConfig(config);
    // Settings the vendor would reject (a malformed folder id) fail here, not on every check.
    def.request(settings, { now: Date.now(), floor: Date.now() });
    if (!(await resolveProjectAutomationActor(row.accountId))) {
      throw new Error(`This account has no owner for Kortix to check ${label} as.`);
    }
    const externalId = streamIdFor(connection.connectionId, type, settings);
    if (!(await getStream(externalId)) && (await countStreams(row.projectId)) >= MAX_STREAMS_PER_PROJECT) {
      throw new Error(`This project already runs ${MAX_STREAMS_PER_PROJECT} app-event checks, the most allowed. Remove an event trigger first.`);
    }
    await upsertStream({
      externalId,
      projectId: row.projectId,
      accountId: row.accountId,
      connectionId: connection.connectionId,
      connectorSlug: connection.connectorSlug,
      eventType: type,
      config: settings,
      intervalSeconds: intervalSeconds(config),
    });
    return { externalId };
  },

  async unsubscribe(externalId) {
    await deleteStream(externalId);
  },

  async instanceExists(externalId) {
    return (await getStream(externalId)) !== null;
  },

  async receive() {
    throw new EventSignatureError('mcp events are polled, not pushed');
  },
};

/** Project MCP connectors of one app, oldest first: the event-types listing of an app reads the first. */
export async function projectConnectorsOfApp(projectId: string, app: string): Promise<Array<{ connectorId: string; slug: string }>> {
  const rows = await db
    .select({ connectorId: connectors.connectorId, slug: connectors.slug, provider: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.providerType, 'mcp')))
    .orderBy(asc(connectors.createdAt));
  return rows.filter((r) => connectorEventApp(r) === app).map(({ connectorId, slug }) => ({ connectorId, slug }));
}
