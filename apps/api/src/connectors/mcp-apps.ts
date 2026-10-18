/**
 * The Kortix MCP app catalogue (`connectors_v2`).
 *
 * Every app here is a remote MCP server that its vendor runs. Kortix connects
 * to it directly, as an `mcp` connector: no Composio, no Pipedream. Sign-in is
 * one of two kinds:
 *
 *   dcr            The vendor's authorization server registers Kortix on the
 *                  fly (RFC 7591). Nothing to configure.
 *   kortix_client  The server has no dynamic registration. Kortix signs in with
 *                  its own OAuth client, configured once per deployment in
 *                  `KORTIX_OAUTH_CLIENTS`. The app is listed only when that
 *                  client is configured.
 *
 * This list is the trust anchor for `kortix_client`. Kortix's client, and the
 * endpoints it is sent to, are used only for a connector whose URL is exactly
 * an entry's `url`, and only with the endpoints written here. A server that
 * merely names Google as its authorization server never gets a token issued
 * through Kortix's Google client.
 *
 * Endpoints and sign-in kinds were verified with a live probe on 2026-10-18
 * (unauthenticated `initialize` → 401 + RFC 9728/8414 metadata). Icons are
 * generated from simple-icons (CC0) into `apps/web/public/connector-icons/`;
 * the marks belong to their owners.
 */
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import { config } from '../config';
import { logger } from '../lib/logger';
import {
  type ConnectorCatalogItem,
  type ConnectorSurfaceVariant,
  createConnectorCatalog,
} from './connector-catalog';

export type KortixOAuthClientName = 'google' | 'github' | 'slack' | 'hubspot' | 'asana' | 'box';

export interface KortixClientAuth {
  kind: 'kortix_client';
  client: KortixOAuthClientName;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  revocationUrl?: string;
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  scopes: string[];
  authorizationParams?: Record<string, string>;
}

export interface McpApp {
  slug: string;
  name: string;
  description: string;
  /** One app per domain: the catalogue lists one card per domain. */
  domain: string;
  categories: string[];
  /** The MCP endpoint (Streamable HTTP). */
  url: string;
  /** `apps/web/public/connector-icons/<slug>.svg` exists. */
  icon: boolean;
  auth: { kind: 'dcr' } | KortixClientAuth;
}

const DCR = { kind: 'dcr' } as const;

const GOOGLE = {
  kind: 'kortix_client',
  client: 'google',
  issuer: 'https://accounts.google.com',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revocationUrl: 'https://oauth2.googleapis.com/revoke',
  tokenEndpointAuthMethod: 'client_secret_post',
  // Google issues a refresh token only for offline access, on a fresh consent.
  authorizationParams: { access_type: 'offline', prompt: 'consent' },
} as const;

/** The scopes each Google Workspace MCP server requires (developers.google.com,
 *  "Configure the Google Workspace MCP servers"). */
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

export const MCP_APPS: readonly McpApp[] = [
  { slug: 'linear', name: 'Linear', description: 'Issues, projects and cycles.', domain: 'linear.app', categories: ['productivity', 'developer-tools'], url: 'https://mcp.linear.app/mcp', icon: true, auth: DCR },
  { slug: 'notion', name: 'Notion', description: 'Pages, databases and comments.', domain: 'notion.so', categories: ['productivity'], url: 'https://mcp.notion.com/mcp', icon: true, auth: DCR },
  { slug: 'atlassian', name: 'Atlassian', description: 'Jira issues and Confluence pages.', domain: 'atlassian.com', categories: ['productivity', 'developer-tools'], url: 'https://mcp.atlassian.com/v1/mcp', icon: true, auth: DCR },
  { slug: 'monday', name: 'monday.com', description: 'Boards, items and updates.', domain: 'monday.com', categories: ['productivity'], url: 'https://mcp.monday.com/mcp', icon: false, auth: DCR },
  { slug: 'clickup', name: 'ClickUp', description: 'Tasks, lists and docs.', domain: 'clickup.com', categories: ['productivity'], url: 'https://mcp.clickup.com/mcp', icon: true, auth: DCR },
  { slug: 'airtable', name: 'Airtable', description: 'Bases, tables and records.', domain: 'airtable.com', categories: ['productivity', 'data'], url: 'https://mcp.airtable.com/mcp', icon: true, auth: DCR },
  { slug: 'dropbox', name: 'Dropbox', description: 'Files and folders.', domain: 'dropbox.com', categories: ['productivity'], url: 'https://mcp.dropbox.com/mcp', icon: true, auth: DCR },
  { slug: 'granola', name: 'Granola', description: 'Meeting notes and transcripts.', domain: 'granola.ai', categories: ['meetings', 'productivity'], url: 'https://mcp.granola.ai/mcp', icon: false, auth: DCR },
  { slug: 'figma', name: 'Figma', description: 'Design files, frames and components.', domain: 'figma.com', categories: ['design'], url: 'https://mcp.figma.com/mcp', icon: true, auth: DCR },
  { slug: 'canva', name: 'Canva', description: 'Designs, folders and exports.', domain: 'canva.com', categories: ['design'], url: 'https://mcp.canva.com/mcp', icon: true, auth: DCR },
  { slug: 'miro', name: 'Miro', description: 'Boards and diagrams.', domain: 'miro.com', categories: ['design', 'productivity'], url: 'https://mcp.miro.com/', icon: true, auth: DCR },
  { slug: 'webflow', name: 'Webflow', description: 'Sites, pages and CMS collections.', domain: 'webflow.com', categories: ['website-builders'], url: 'https://mcp.webflow.com/mcp', icon: true, auth: DCR },
  { slug: 'wix', name: 'Wix', description: 'Sites, stores and bookings.', domain: 'wix.com', categories: ['website-builders'], url: 'https://mcp.wix.com/mcp', icon: true, auth: DCR },
  { slug: 'jotform', name: 'Jotform', description: 'Forms and submissions.', domain: 'jotform.com', categories: ['operations'], url: 'https://mcp.jotform.com/', icon: false, auth: DCR },
  { slug: 'stripe', name: 'Stripe', description: 'Customers, payments and subscriptions.', domain: 'stripe.com', categories: ['payments'], url: 'https://mcp.stripe.com', icon: true, auth: DCR },
  { slug: 'paypal', name: 'PayPal', description: 'Invoices, orders and payments.', domain: 'paypal.com', categories: ['payments'], url: 'https://mcp.paypal.com/mcp', icon: true, auth: DCR },
  { slug: 'attio', name: 'Attio', description: 'CRM records, lists and notes.', domain: 'attio.com', categories: ['crm'], url: 'https://mcp.attio.com/mcp', icon: false, auth: DCR },
  { slug: 'close', name: 'Close', description: 'Leads, opportunities and activities.', domain: 'close.com', categories: ['crm'], url: 'https://mcp.close.com/mcp', icon: false, auth: DCR },
  { slug: 'intercom', name: 'Intercom', description: 'Conversations, contacts and tickets.', domain: 'intercom.com', categories: ['customer-support'], url: 'https://mcp.intercom.com/mcp', icon: true, auth: DCR },
  { slug: 'posthog', name: 'PostHog', description: 'Product analytics, flags and experiments.', domain: 'posthog.com', categories: ['product-analytics'], url: 'https://mcp.posthog.com/mcp', icon: true, auth: DCR },
  { slug: 'sentry', name: 'Sentry', description: 'Errors, issues and releases.', domain: 'sentry.io', categories: ['developer-tools', 'monitoring'], url: 'https://mcp.sentry.dev/mcp', icon: true, auth: DCR },
  { slug: 'supabase', name: 'Supabase', description: 'Projects, databases and edge functions.', domain: 'supabase.com', categories: ['developer-tools', 'database'], url: 'https://mcp.supabase.com/mcp', icon: true, auth: DCR },
  { slug: 'neon', name: 'Neon', description: 'Serverless Postgres projects and branches.', domain: 'neon.tech', categories: ['developer-tools', 'database'], url: 'https://mcp.neon.tech/mcp', icon: false, auth: DCR },
  { slug: 'vercel', name: 'Vercel', description: 'Projects, deployments and logs.', domain: 'vercel.com', categories: ['developer-tools', 'hosting'], url: 'https://mcp.vercel.com', icon: true, auth: DCR },
  { slug: 'cloudflare', name: 'Cloudflare', description: 'Accounts, Workers and DNS.', domain: 'cloudflare.com', categories: ['developer-tools', 'hosting'], url: 'https://mcp.cloudflare.com/mcp', icon: true, auth: DCR },
  {
    slug: 'gmail', name: 'Gmail', description: 'Read, search and draft email.', domain: 'gmail.com', categories: ['email'], url: 'https://gmailmcp.googleapis.com/mcp/v1', icon: true,
    auth: { ...GOOGLE, scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'] },
  },
  {
    slug: 'google_calendar', name: 'Google Calendar', description: 'Calendars, events and free time.', domain: 'calendar.google.com', categories: ['productivity', 'meetings'], url: 'https://calendarmcp.googleapis.com/mcp/v1', icon: true,
    auth: { ...GOOGLE, scopes: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.events.readonly'] },
  },
  {
    slug: 'google_drive', name: 'Google Drive', description: 'Files and folders.', domain: 'drive.google.com', categories: ['productivity'], url: 'https://drivemcp.googleapis.com/mcp/v1', icon: true,
    auth: { ...GOOGLE, scopes: DRIVE_SCOPES },
  },
  {
    slug: 'google_docs', name: 'Google Docs', description: 'Documents.', domain: 'docs.google.com', categories: ['productivity'], url: 'https://docsmcp.googleapis.com/mcp/v1', icon: true,
    auth: { ...GOOGLE, scopes: [...DRIVE_SCOPES, 'https://www.googleapis.com/auth/documents.readonly', 'https://www.googleapis.com/auth/documents'] },
  },
  {
    slug: 'google_sheets', name: 'Google Sheets', description: 'Spreadsheets.', domain: 'sheets.google.com', categories: ['productivity', 'data'], url: 'https://sheetsmcp.googleapis.com/mcp/v1', icon: true,
    auth: { ...GOOGLE, scopes: [...DRIVE_SCOPES, 'https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets'] },
  },
  {
    slug: 'github', name: 'GitHub', description: 'Repositories, issues and pull requests.', domain: 'github.com', categories: ['developer-tools'], url: 'https://api.githubcopilot.com/mcp/', icon: true,
    auth: { kind: 'kortix_client', client: 'github', issuer: 'https://github.com/login/oauth', authorizationUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', tokenEndpointAuthMethod: 'client_secret_post', scopes: ['repo', 'read:org', 'read:user', 'user:email'] },
  },
  {
    slug: 'slack', name: 'Slack', description: 'Search and post as you in Slack.', domain: 'slack.com', categories: ['messaging'], url: 'https://mcp.slack.com/mcp', icon: true,
    auth: { kind: 'kortix_client', client: 'slack', issuer: 'https://mcp.slack.com', authorizationUrl: 'https://slack.com/oauth/v2_user/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.user.access', tokenEndpointAuthMethod: 'client_secret_post', scopes: ['channels:history', 'channels:read', 'chat:write', 'groups:history', 'groups:read', 'im:history', 'im:read', 'search:read.public', 'users:read'] },
  },
  {
    slug: 'hubspot', name: 'HubSpot', description: 'Contacts, companies and deals.', domain: 'hubspot.com', categories: ['crm', 'marketing'], url: 'https://mcp.hubspot.com/', icon: true,
    auth: { kind: 'kortix_client', client: 'hubspot', issuer: 'https://mcp.hubspot.com', authorizationUrl: 'https://mcp.hubspot.com/oauth/authorize/user', tokenUrl: 'https://mcp.hubspot.com/oauth/v3/token', tokenEndpointAuthMethod: 'client_secret_post', scopes: [] },
  },
  {
    slug: 'asana', name: 'Asana', description: 'Tasks, projects and portfolios.', domain: 'asana.com', categories: ['productivity'], url: 'https://mcp.asana.com/v2/mcp', icon: true,
    auth: { kind: 'kortix_client', client: 'asana', issuer: 'https://app.asana.com', authorizationUrl: 'https://app.asana.com/-/oauth_authorize', tokenUrl: 'https://app.asana.com/-/oauth_token', revocationUrl: 'https://app.asana.com/-/oauth_revoke', tokenEndpointAuthMethod: 'client_secret_post', scopes: ['default'] },
  },
  {
    slug: 'box', name: 'Box', description: 'Files, folders and Box AI.', domain: 'box.com', categories: ['productivity'], url: 'https://mcp.box.com', icon: true,
    auth: { kind: 'kortix_client', client: 'box', issuer: 'https://api.box.com', authorizationUrl: 'https://account.box.com/api/oauth2/authorize', tokenUrl: 'https://api.box.com/oauth2/token', revocationUrl: 'https://api.box.com/oauth2/revoke', tokenEndpointAuthMethod: 'client_secret_post', scopes: [] },
  },
];

interface KortixOAuthClient {
  client_id: string;
  client_secret: string;
}

let parsedClients: { raw: string; clients: Map<string, KortixOAuthClient> } | null = null;

/** `KORTIX_OAUTH_CLIENTS`, parsed once per value. A malformed value lists no client. */
export function kortixOAuthClients(raw: string = config.KORTIX_OAUTH_CLIENTS ?? ''): Map<string, KortixOAuthClient> {
  if (parsedClients?.raw === raw) return parsedClients.clients;
  const clients = new Map<string, KortixOAuthClient>();
  if (raw.trim()) {
    try {
      for (const [name, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        const entry = value as Partial<KortixOAuthClient> | null;
        if (typeof entry?.client_id === 'string' && entry.client_id && typeof entry.client_secret === 'string' && entry.client_secret) {
          clients.set(name, { client_id: entry.client_id, client_secret: entry.client_secret });
        }
      }
    } catch {
      logger.warn('[mcp-apps] KORTIX_OAUTH_CLIENTS is not valid JSON; no Kortix OAuth client is configured');
    }
  }
  parsedClients = { raw, clients };
  return clients;
}

/** An app is usable when it needs no client of Kortix's, or that client is configured. */
export function mcpAppAvailable(app: McpApp, clients = kortixOAuthClients()): boolean {
  return app.auth.kind === 'dcr' || clients.has(app.auth.client);
}

export function availableMcpApps(clients = kortixOAuthClients()): McpApp[] {
  return MCP_APPS.filter((app) => mcpAppAvailable(app, clients));
}

/** `https://Mcp.Linear.app/mcp/` and `https://mcp.linear.app/mcp` are one server. */
function endpointKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.search || parsed.hash) return null;
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The catalogue entry whose MCP endpoint is exactly `url`. */
export function mcpAppForUrl(url: string): McpApp | null {
  const key = endpointKey(url);
  if (!key) return null;
  return MCP_APPS.find((app) => endpointKey(app.url) === key) ?? null;
}

/**
 * The OAuth application Kortix signs in with for the MCP server at `url`:
 * Kortix's own client, with the catalogue's endpoints and scopes. `null` when
 * `url` is not a `kortix_client` app or its client is not configured.
 */
export function kortixClientApplication(
  url: string,
  clients = kortixOAuthClients(),
): OAuth2ApplicationInput | null {
  const app = mcpAppForUrl(url);
  if (!app || app.auth.kind !== 'kortix_client') return null;
  const client = clients.get(app.auth.client);
  if (!client) return null;
  const auth = app.auth;
  return {
    issuer: auth.issuer,
    authorization_url: auth.authorizationUrl,
    token_url: auth.tokenUrl,
    ...(auth.revocationUrl ? { revocation_url: auth.revocationUrl } : {}),
    client_id: client.client_id,
    client_secret: client.client_secret,
    token_endpoint_auth_method: auth.tokenEndpointAuthMethod,
    ...(auth.scopes.length ? { scopes: auth.scopes } : {}),
    ...(auth.authorizationParams ? { authorization_params: auth.authorizationParams } : {}),
  };
}

/** The Popular section, in this order. */
const POPULAR = ['gmail', 'google_calendar', 'slack', 'github', 'notion', 'linear', 'google_drive', 'hubspot', 'atlassian', 'figma', 'airtable', 'stripe'];

export function mcpAppIcon(app: McpApp): string | null {
  return app.icon ? `/connector-icons/${app.slug}.svg` : null;
}

/** An app as a Discover catalogue record, so the web's Discover grid,
 *  app page and Install serve it unchanged. */
export function mcpAppCatalogItem(app: McpApp): ConnectorCatalogItem {
  const rank = POPULAR.indexOf(app.slug);
  return {
    id: `kortix:${app.slug}`,
    kind: 'mcp',
    slug: app.slug,
    name: app.name,
    description: app.description,
    url: `https://${app.domain}`,
    icon: mcpAppIcon(app),
    domain: app.domain,
    categories: app.categories,
    feeds: ['kortix'],
    popularity: rank === -1 ? null : POPULAR.length - rank,
    mcpUrl: app.url,
    oauth: true,
  };
}

/** The one surface Install builds the connector from: the vendor's MCP server. */
export function mcpAppSurface(app: McpApp): ConnectorSurfaceVariant {
  return {
    id: `kortix:${app.slug}:mcp`,
    kind: 'mcp',
    name: app.name,
    url: app.url,
    docs: null,
    description: app.description,
    transports: ['http'],
    requiresAuth: true,
    command: null,
    connector: { provider: 'mcp', url: app.url, transport: 'http' },
  };
}

/** The Discover catalogue a `connectors_v2` project browses: Kortix's own list. */
export const kortixMcpCatalog = createConnectorCatalog({
  source: {
    items: () => availableMcpApps().map(mcpAppCatalogItem),
    surfaces: (domain) => availableMcpApps().filter((app) => app.domain === domain).map(mcpAppSurface),
  },
});
