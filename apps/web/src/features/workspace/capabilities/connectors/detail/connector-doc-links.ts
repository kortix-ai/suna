import type { AdminConnector } from '@kortix/sdk';

import { foldKey } from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';

export interface ConnectorDocLink {
  label: string;
  href: string;
  /** Leaves kortix.com — rendered with an external-arrow glyph and `target="_blank"`. */
  external: boolean;
}

/**
 * The Kortix docs page that explains how THIS kind of connector connects.
 * Anchors point at the exact section, not the page top — the person clicking
 * is mid-setup and should land on the paragraph that unblocks them.
 * Anchor slugs match the headings in `apps/web/content/docs/connect/*.mdx`.
 */
function kortixDocsHref(provider: AdminConnector['provider']): string {
  switch (provider) {
    case 'composio':
    case 'pipedream':
      return '/docs/connect/connectors#connect-with-oauth';
    case 'mcp':
      return '/docs/connect/connectors#connect-an-mcp-server-that-uses-oauth-21';
    case 'channel':
      return '/docs/connect/slack';
    case 'computer':
      return '/docs/connect/computers';
    default:
      return '/docs/connect/connectors';
  }
}

/**
 * Developer-docs home for the apps people actually connect. Keyed by
 * `foldKey(slug)` AND `foldKey(name)` so `google_sheets`, `Google Sheets` and
 * `googlesheets` all resolve. Curated, not exhaustive: a wrong or dead link
 * is worse than no link, so entries are the stable, top-level API-docs URLs
 * only. A connector with no entry simply shows no provider-docs link.
 */
const APP_DOCS: Record<string, { docs: string; website?: string }> = {
  github: { docs: 'https://docs.github.com/en/rest', website: 'https://github.com' },
  gitlab: { docs: 'https://docs.gitlab.com/ee/api/', website: 'https://gitlab.com' },
  linear: { docs: 'https://linear.app/developers', website: 'https://linear.app' },
  slack: { docs: 'https://api.slack.com/docs', website: 'https://slack.com' },
  notion: { docs: 'https://developers.notion.com', website: 'https://notion.so' },
  jira: { docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/' },
  confluence: { docs: 'https://developer.atlassian.com/cloud/confluence/rest/v2/' },
  gmail: { docs: 'https://developers.google.com/workspace/gmail/api/guides' },
  googlecalendar: { docs: 'https://developers.google.com/workspace/calendar' },
  googledrive: { docs: 'https://developers.google.com/workspace/drive' },
  googlesheets: { docs: 'https://developers.google.com/workspace/sheets' },
  googledocs: { docs: 'https://developers.google.com/workspace/docs' },
  stripe: { docs: 'https://docs.stripe.com/api', website: 'https://stripe.com' },
  hubspot: { docs: 'https://developers.hubspot.com/docs/api/overview' },
  salesforce: { docs: 'https://developer.salesforce.com/docs' },
  attio: { docs: 'https://docs.attio.com', website: 'https://attio.com' },
  airtable: { docs: 'https://airtable.com/developers/web/api/introduction' },
  asana: { docs: 'https://developers.asana.com/docs' },
  discord: { docs: 'https://discord.com/developers/docs' },
  telegram: { docs: 'https://core.telegram.org/bots/api' },
  telegrambotapi: { docs: 'https://core.telegram.org/bots/api' },
  openai: { docs: 'https://platform.openai.com/docs' },
  anthropic: { docs: 'https://docs.anthropic.com' },
  figma: { docs: 'https://www.figma.com/developers/api' },
  zendesk: { docs: 'https://developer.zendesk.com/api-reference/' },
  intercom: { docs: 'https://developers.intercom.com/docs' },
  shopify: { docs: 'https://shopify.dev/docs/api' },
  supabase: { docs: 'https://supabase.com/docs/reference/api' },
  vercel: { docs: 'https://vercel.com/docs/rest-api' },
  sentry: { docs: 'https://docs.sentry.io/api/' },
  posthog: { docs: 'https://posthog.com/docs/api' },
  cloudflare: { docs: 'https://developers.cloudflare.com/api/' },
  twilio: { docs: 'https://www.twilio.com/docs' },
  sendgrid: { docs: 'https://www.twilio.com/docs/sendgrid' },
  mailchimp: { docs: 'https://mailchimp.com/developer/' },
  dropbox: { docs: 'https://www.dropbox.com/developers/documentation' },
  monday: { docs: 'https://developer.monday.com/api-reference' },
  clickup: { docs: 'https://developer.clickup.com' },
  trello: { docs: 'https://developer.atlassian.com/cloud/trello/' },
  todoist: { docs: 'https://developer.todoist.com' },
  calendly: { docs: 'https://developer.calendly.com' },
  zoom: { docs: 'https://developers.zoom.us/docs/api/' },
  microsoftteams: { docs: 'https://learn.microsoft.com/en-us/microsoftteams/platform/' },
  outlook: { docs: 'https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview' },
  pipedrive: { docs: 'https://developers.pipedrive.com/docs/api/v1' },
  snowflake: { docs: 'https://docs.snowflake.com/en/developer-guide' },
};

function appDocsEntry(
  connector: Pick<AdminConnector, 'slug' | 'name'>,
): { docs: string; website?: string } | null {
  return APP_DOCS[foldKey(connector.slug)] ?? APP_DOCS[foldKey(connector.name ?? '')] ?? null;
}

/**
 * Every reference link the detail page shows for one connector, in render
 * order: the Kortix guide first (it describes the exact clicks on THIS page),
 * then the provider's own developer docs (where the API key or server URL
 * comes from), then the MCP specification for MCP servers, then the app's
 * website.
 */
export function connectorDocLinks(
  connector: Pick<AdminConnector, 'provider' | 'slug' | 'name'>,
): ConnectorDocLink[] {
  const links: ConnectorDocLink[] = [
    { label: 'Kortix docs', href: kortixDocsHref(connector.provider), external: false },
  ];
  const app = appDocsEntry(connector);
  if (app) {
    const name = connector.name?.trim() || connector.slug;
    links.push({ label: `${name} API docs`, href: app.docs, external: true });
    if (app.website) links.push({ label: 'Website', href: app.website, external: true });
  }
  if (connector.provider === 'mcp') {
    links.push({ label: 'MCP docs', href: 'https://modelcontextprotocol.io/docs', external: true });
  }
  return links;
}
