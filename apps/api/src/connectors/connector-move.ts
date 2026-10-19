/**
 * Move a Pipedream or Composio connector to the Kortix MCP app for the same
 * service (`connectors_v2`).
 *
 * Kortix retires Pipedream and Composio. Their OAuth grants belong to their own
 * clients, so each owner signs in once more. A move keeps the connector's slug
 * and connection rows, so agent grants, session bindings and other kortix.yaml
 * references do not change. Its Composio event triggers are rewritten to the
 * Kortix events that replace them, in the same kortix.yaml commit.
 *
 *   1. `moveConnector` marks one connection (`metadata.move_to`, sealed with the
 *      project's key, so the account's owner cannot forge it). The old provider
 *      still serves the connector.
 *   2. The person signs in on that connection with the ordinary OAuth routes.
 *      For a marked connection, the OAuth target is the catalogue app for the
 *      connector's `app` (`moveTargetApp`). It never comes from the request or
 *      from stored metadata.
 *   3. When the sign-in stores its token, `finishMarkedMove` rewrites the
 *      kortix.yaml entry to `provider: mcp` and syncs. The other connections
 *      keep their rows but lose their old binding, so their owners sign in again.
 */
import {
  connectionCredentials,
  connectorConnections,
  connectorPolicies,
  connectorProjectPolicies,
  connectors,
  projectTriggerRuntime,
  projects,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { logger } from '../lib/logger';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/surface';
import { db } from '../shared/db';
import { ensureDefaultConnection } from './credentials';
import { type CrudResult, type EditableManifest, upsertConnectorInManifest } from './manifest-crud';
import { MCP_APPS, type McpApp, mcpAppAvailable, mcpAppForUrl, mcpAppIcon } from './mcp-apps';

/**
 * The old provider's app slug → the Kortix catalogue app. Read from each
 * provider's live app list on 2026-10-19 (Pipedream `/v1/apps`, Composio
 * `/api/v3/toolkits`). Not mapped: data-center and bot editions
 * (`jira_data_center`, `slack_bot`, `slackbot`), database logins
 * (`neon_postgres`), multi-app bundles (`googlesuper`), a read-only edition
 * that would widen access (`supabase_read_mcp`), and Slack, which the Slack
 * channel replaces.
 */
const MOVE_APPS = {
  pipedream: {
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
    stripe: 'stripe',
    supabase: 'supabase',
    supabase_management_api: 'supabase',
    vercel_token_auth: 'vercel',
    webflow: 'webflow',
    wix_api_key: 'wix',
  },
  composio: {
    airtable: 'airtable',
    asana: 'asana',
    atlassian_mcp: 'atlassian',
    attio: 'attio',
    box: 'box',
    box_mcp: 'box',
    canva: 'canva',
    canva_mcp: 'canva',
    clickup: 'clickup',
    clickup_mcp: 'clickup',
    close: 'close',
    close_mcp: 'close',
    cloudflare: 'cloudflare',
    cloudflare_api_key: 'cloudflare',
    cloudflare_mcp: 'cloudflare',
    confluence: 'atlassian',
    dropbox: 'dropbox',
    figma: 'figma',
    github: 'github',
    github_mcp: 'github',
    gmail: 'gmail',
    googlecalendar: 'google_calendar',
    googledocs: 'google_docs',
    googledrive: 'google_drive',
    googlesheets: 'google_sheets',
    granola_mcp: 'granola',
    hubspot: 'hubspot',
    intercom: 'intercom',
    intercom_mcp: 'intercom',
    jira: 'atlassian',
    jotform: 'jotform',
    linear: 'linear',
    linear_mcp: 'linear',
    miro: 'miro',
    monday: 'monday',
    monday_mcp: 'monday',
    neon: 'neon',
    neon_mcp: 'neon',
    notion: 'notion',
    notion_mcp: 'notion',
    paypal: 'paypal',
    posthog: 'posthog',
    posthog_mcp: 'posthog',
    sentry: 'sentry',
    sentry_mcp: 'sentry',
    stripe: 'stripe',
    stripe_mcp: 'stripe',
    supabase: 'supabase',
    supabase_mcp: 'supabase',
    vercel: 'vercel',
    vercel_mcp: 'vercel',
    webflow: 'webflow',
    wix: 'wix',
    wix_mcp: 'wix',
  },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

export type MovableProvider = keyof typeof MOVE_APPS;

export function isMovableProvider(provider: string): provider is MovableProvider {
  return provider === 'pipedream' || provider === 'composio';
}

/** The catalogue app a connector of a retired provider moves to, when this deployment can sign in to it. */
export function mcpAppForMovedApp(provider: string, app: unknown): McpApp | null {
  if (!isMovableProvider(provider) || typeof app !== 'string') return null;
  const slug = (MOVE_APPS[provider] as Readonly<Record<string, string>>)[app];
  const target = slug ? MCP_APPS.find((candidate) => candidate.slug === slug) : undefined;
  return target && mcpAppAvailable(target) ? target : null;
}

/**
 * The catalogue app a connector moves to: from its provider and `app` only. The
 * MCP server URL a move signs in to never comes from a request or stored data.
 */
export function moveTargetApp(providerType: string, config: Record<string, unknown> | null): McpApp | null {
  return mcpAppForMovedApp(providerType, config?.app);
}

/** Kortix's own `interval` presets, in minutes (trigger-events/mcp-events.ts). */
const INTERVAL_PRESETS = [1, 5, 15, 30, 60, 360, 1440] as const;

function intervalPreset(value: unknown): number | null {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return INTERVAL_PRESETS.find((preset) => preset >= minutes) ?? 1440;
}

/**
 * The Kortix event that replaces a Composio trigger type, with its config.
 * Null: no Kortix event replaces it yet, or its config has no Kortix equivalent
 * (Gmail labels other than the inbox). Composio `interval` is minutes; it rounds
 * up to the next Kortix preset, so a trigger never checks more often than before.
 */
export function kortixEventForComposioTrigger(
  type: string,
  config: Record<string, unknown>,
): { type: string; config: Record<string, unknown> } | null {
  const interval = intervalPreset(config.interval);
  const text = (key: string) => (typeof config[key] === 'string' && (config[key] as string).trim() ? (config[key] as string).trim() : null);
  const out = (eventType: string, fields: Record<string, string | null>) => ({
    type: eventType,
    config: {
      ...Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== null)),
      ...(interval ? { interval } : {}),
    },
  });
  switch (type) {
    case 'GMAIL_NEW_GMAIL_MESSAGE': {
      const labels = config.labelIds;
      const inboxOnly =
        labels === undefined ||
        labels === null ||
        labels === 'INBOX' ||
        (Array.isArray(labels) && labels.length === 1 && labels[0] === 'INBOX');
      return inboxOnly ? out('gmail.message.received', { query: text('query') }) : null;
    }
    case 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER':
      return out('google_calendar.event.created', { calendar_id: text('calendarId') });
    case 'GOOGLEDRIVE_FILE_CREATED_TRIGGER':
      return out('google_drive.file.created', { folder_id: text('folder_id'), query: text('query') });
    default:
      return null;
  }
}

/**
 * The move mark on a connection (`metadata.move_to`), sealed with the project's
 * key. Connection metadata is writable by the account's owner, so a plain
 * string would let a member start a move that only a connector writer may start.
 */
function moveMark(projectId: string, connectionId: string, app: string): string {
  return encryptProjectSecret(projectId, `connector-move/v1:${connectionId}:${app}`);
}

function isMoveMark(projectId: string, connectionId: string, app: string, value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    return decryptProjectSecret(projectId, value) === `connector-move/v1:${connectionId}:${app}`;
  } catch {
    return false;
  }
}

interface MoveConnectionRow {
  projectId: string;
  connectionId: string;
  providerType: string;
  config: Record<string, unknown> | null;
  connectionMetadata: Record<string, unknown> | null;
  projectMetadata: unknown;
}

/** The app a connection moves its connector to: a sealed mark, in a `connectors_v2` project. */
function markedMoveApp(row: MoveConnectionRow): McpApp | null {
  if (!resolveFeatureFlag(row.projectMetadata, 'connectors_v2')) return null;
  const app = moveTargetApp(row.providerType, row.config);
  return app && isMoveMark(row.projectId, row.connectionId, app.slug, row.connectionMetadata?.move_to) ? app : null;
}

async function loadMoveConnection(connectionId: string) {
  const [row] = await db
    .select({
      projectId: connectors.projectId,
      accountId: connectors.accountId,
      connectorId: connectors.connectorId,
      connectionId: connectorConnections.connectionId,
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
  return row ?? null;
}

/** The MCP server a marked connection of a Pipedream or Composio connector signs in to, else null. */
export async function moveTargetUrlForConnection(connectionId: string): Promise<string | null> {
  const row = await loadMoveConnection(connectionId);
  return row ? (markedMoveApp(row)?.url ?? null) : null;
}

/**
 * Tool rules that name the old provider's tools: a connector rule other than
 * `*`, or a project rule on `<slug>.<tool>`. The Kortix app names its tools
 * differently, so after a move a `block` rule would match nothing.
 */
async function oldToolRules(projectId: string, connectorId: string, slug: string): Promise<string[]> {
  const [own, project] = await Promise.all([
    db.select({ match: connectorPolicies.match }).from(connectorPolicies).where(eq(connectorPolicies.connectorId, connectorId)),
    db.select({ match: connectorProjectPolicies.match }).from(connectorProjectPolicies).where(eq(connectorProjectPolicies.projectId, projectId)),
  ]);
  const prefix = `${slug.toLowerCase()}.`;
  return [
    ...own.map((row) => row.match).filter((match) => match !== '*'),
    ...project
      .map((row) => row.match)
      .filter((match) => match.toLowerCase().startsWith(prefix) && match.toLowerCase() !== `${prefix}*`),
  ];
}

function toolRulesRefusal(slug: string, provider: string, rules: string[]): string {
  return `${slug} has tool rules for ${providerName(provider)} tool names (${rules.join(', ')}). The Kortix app names its tools differently, so those rules would stop matching. Remove them, move, then add rules for the new tool names.`;
}

function providerName(provider: string): string {
  return provider === 'composio' ? 'Composio' : 'Pipedream';
}

export interface EventTriggerRef {
  slug: string;
  type: string;
  config: Record<string, unknown>;
}

/** The event triggers on a connector, from the materialized kortix.yaml triggers. */
async function connectorEventTriggers(projectId: string, connectorSlug: string): Promise<EventTriggerRef[]> {
  const rows = await db
    .select({ slug: projectTriggerRuntime.slug, spec: projectTriggerRuntime.scheduleSpec })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.triggerType, 'event')));
  return rows.flatMap((row) => {
    const event = (row.spec as { event?: { connector?: unknown; type?: unknown; config?: unknown } } | null)?.event;
    if (event?.connector !== connectorSlug || typeof event.type !== 'string') return [];
    const config = event.config && typeof event.config === 'object' ? (event.config as Record<string, unknown>) : {};
    return [{ slug: row.slug, type: event.type, config }];
  });
}

/** Composio triggers no Kortix event replaces: they would stop firing after a move. */
function unmappedTriggers(triggers: EventTriggerRef[]): EventTriggerRef[] {
  return triggers.filter((trigger) => !kortixEventForComposioTrigger(trigger.type, trigger.config));
}

function triggersRefusal(slug: string, triggers: EventTriggerRef[]): string {
  return `${slug} has Composio event triggers that no Kortix event replaces yet (${triggers.map((t) => `${t.slug}: ${t.type}`).join(', ')}). Delete or change them, then move.`;
}

/**
 * Rewrite the connector's Composio event triggers in kortix.yaml to the Kortix
 * events that replace them. An error when one is missing from kortix.yaml (an
 * imported file declares it) or has no replacement.
 */
export function rewriteComposioTriggers(
  manifest: Pick<EditableManifest, 'raw'>,
  connectorSlug: string,
  expected: EventTriggerRef[],
): string | null {
  const entries = Array.isArray(manifest.raw.triggers) ? (manifest.raw.triggers as Record<string, unknown>[]) : [];
  const rewritten = new Set<string>();
  for (const entry of entries) {
    if (entry?.type !== 'event' || entry.connector !== connectorSlug || typeof entry.event !== 'string') continue;
    const config = entry.config && typeof entry.config === 'object' ? (entry.config as Record<string, unknown>) : {};
    const replacement = kortixEventForComposioTrigger(entry.event, config);
    if (!replacement) return triggersRefusal(connectorSlug, [{ slug: String(entry.slug), type: entry.event, config }]);
    entry.event = replacement.type;
    if (Object.keys(replacement.config).length > 0) entry.config = replacement.config;
    else delete entry.config;
    delete entry.source;
    rewritten.add(String(entry.slug));
  }
  const elsewhere = expected.filter((trigger) => !rewritten.has(trigger.slug));
  return elsewhere.length > 0
    ? `${connectorSlug} has event triggers declared outside kortix.yaml (${elsewhere.map((t) => t.slug).join(', ')}). Move them into kortix.yaml or delete them, then move.`
    : null;
}

export interface ConnectorMove {
  slug: string;
  name: string;
  /** The retired provider the connector runs on. */
  provider: MovableProvider;
  /** The connector's app on that provider. */
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

/** Every Pipedream and Composio connector of the project, with the Kortix app it can move to. */
export async function listConnectorMoves(projectId: string): Promise<ConnectorMove[]> {
  const rows = await db
    .select({
      connectorId: connectors.connectorId,
      slug: connectors.slug,
      name: connectors.name,
      providerType: connectors.providerType,
      config: connectors.config,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), inArray(connectors.providerType, ['pipedream', 'composio'])));
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
      const to = mcpAppForMovedApp(row.providerType, app);
      const own = connections.filter((connection) => connection.connectorId === row.connectorId);
      const marked = to
        ? own.find((connection) => isMoveMark(projectId, connection.connectionId, to.slug, connection.metadata?.move_to))
        : undefined;
      return {
        slug: row.slug,
        name: row.name,
        provider: row.providerType as MovableProvider,
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

/** Why this connector cannot move now, or null. Checked at the start and again at the switch. */
async function moveBlocker(projectId: string, connectorId: string, slug: string, provider: string): Promise<string | null> {
  const rules = await oldToolRules(projectId, connectorId, slug);
  if (rules.length > 0) return toolRulesRefusal(slug, provider, rules);
  if (provider !== 'composio') return null;
  const unmapped = unmappedTriggers(await connectorEventTriggers(projectId, slug));
  return unmapped.length > 0 ? triggersRefusal(slug, unmapped) : null;
}

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
  if (!isMovableProvider(connector.providerType)) {
    return {
      ok: false,
      status: 409,
      error: `Only a Pipedream or Composio connector moves. ${input.slug} uses ${connector.providerType}.`,
    };
  }
  const app = (connector.config as { app?: unknown } | null)?.app;
  const to = mcpAppForMovedApp(connector.providerType, app);
  if (!to) {
    return {
      ok: false,
      status: 409,
      error: `Kortix has no connection for ${String(app ?? input.slug)} on this deployment yet. The connector keeps working through ${providerName(connector.providerType)}.`,
    };
  }
  const blocker = await moveBlocker(input.projectId, connector.connectorId, input.slug, connector.providerType);
  if (blocker) return { ok: false, status: 409, error: blocker };

  const own = await db
    .select({ connectionId: connectorConnections.connectionId, metadata: connectorConnections.metadata, kind: connectionCredentials.kind })
    .from(connectorConnections)
    .leftJoin(connectionCredentials, eq(connectionCredentials.connectionId, connectorConnections.connectionId))
    .where(eq(connectorConnections.connectorId, connector.connectorId));
  const signedIn = own.find(
    (connection) =>
      connection.kind === 'oauth2_delegated' &&
      isMoveMark(input.projectId, connection.connectionId, to.slug, connection.metadata?.move_to),
  );
  if (signedIn) {
    const finished = await finishMarkedMove(signedIn.connectionId);
    if (finished && !finished.ok) return { ok: false, status: finished.status === 409 ? 409 : 502, error: finished.error };
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
  const mark = moveMark(input.projectId, connectionId, to.slug);
  // One marked account per connector: a second start moves the mark.
  await db.transaction(async (tx) => {
    await tx
      .update(connectorConnections)
      .set({ metadata: sql`${connectorConnections.metadata} - 'move_to'`, updatedAt: new Date() })
      .where(and(eq(connectorConnections.connectorId, connector.connectorId), sql`${connectorConnections.metadata}->>'move_to' is not null`));
    await tx
      .update(connectorConnections)
      .set({ metadata: sql`${connectorConnections.metadata} || ${JSON.stringify({ move_to: mark })}::jsonb`, updatedAt: new Date() })
      .where(eq(connectorConnections.connectionId, connectionId));
  });
  return { ok: true, status: 'sign_in', connection_id: connectionId, to: { slug: to.slug, name: to.name, url: to.url } };
}

/**
 * Connection metadata the old providers wrote: a Composio account binding and
 * the identity it was signed in as. Without them, an account that did not move
 * reads "not signed in" (`connectionSignedIn` reads `connected_account_id`).
 */
const OLD_PROVIDER_METADATA = sql.raw(
  `ARRAY['provider','toolkit','stable_user_id','session_id','auth_request_id','connected_account_id','is_no_auth','connected_as','move_to']::text[]`,
);

/**
 * Switch a connector to its Kortix app once its marked connection holds a
 * Kortix sign-in. Null when the connection is not a signed-in move. Called
 * after every OAuth sign-in on a Pipedream or Composio connector, and by a
 * retried `moveConnector`.
 */
export async function finishMarkedMove(connectionId: string): Promise<CrudResult | null> {
  const row = await loadMoveConnection(connectionId);
  if (!row || row.kind !== 'oauth2_delegated') return null;
  const app = markedMoveApp(row);
  if (!app) return null;
  // A rule or a trigger added after the move started still names the old provider's tools or events.
  const blocker = await moveBlocker(row.projectId, row.connectorId, row.slug, row.providerType);
  if (blocker) {
    logger.warn('[connectors] connector move waits on old tool rules or triggers', { connectionId });
    return { ok: false, status: 409, error: blocker };
  }
  const triggers = row.providerType === 'composio' ? await connectorEventTriggers(row.projectId, row.slug) : [];

  const result = await upsertConnectorInManifest(
    row.projectId,
    row.accountId,
    { slug: row.slug, name: row.name, provider: 'mcp', url: app.url, transport: 'http' },
    {
      alsoMutate: (manifest) => (triggers.length > 0 ? rewriteComposioTriggers(manifest, row.slug, triggers) : null),
      beforeSync: async () => {
        // The other accounts hold the old provider's binding (a Pipedream account
        // id, a Composio account), which no MCP server accepts: without it they
        // read "not signed in" and their owners sign in again.
        await db.transaction(async (tx) => {
          await tx
            .delete(connectionCredentials)
            .where(and(eq(connectionCredentials.connectorId, row.connectorId), eq(connectionCredentials.kind, 'connection')));
          await tx
            .update(connectorConnections)
            .set({ metadata: sql`${connectorConnections.metadata} - ${OLD_PROVIDER_METADATA}`, updatedAt: new Date() })
            .where(eq(connectorConnections.connectorId, row.connectorId));
        });
      },
    },
  );
  if (!result.ok) {
    logger.warn('[connectors] connector move did not switch the connector', { connectionId, error: result.error });
  }
  return result;
}
